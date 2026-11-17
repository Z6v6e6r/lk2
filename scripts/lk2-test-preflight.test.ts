import { describe, expect, it } from 'vitest';
import {
  compareFingerprints,
  main,
  parseArguments,
  parseAssetlinks,
  renderReport,
  runPreflight,
  summarize,
  type CheckResult,
} from './lk2-test-preflight.js';

const DEBUG_CERT =
  '22:07:BD:6E:B9:0A:EF:E4:4D:BD:04:3A:9C:FA:CD:17:54:13:13:BE:C3:A5:95:8D:05:1B:E8:07:E0:0B:EF:93';
const RELEASE_CERT =
  '8C:59:A9:D1:96:23:97:66:D5:03:F5:52:0B:F0:CB:89:91:C8:63:08:9A:6D:F6:18:FB:18:E4:7A:E4:02:70:1E';
const BASE_URL = 'https://lk2.example';

function assetlinks(fingerprints: readonly string[]): unknown {
  return [
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: 'ru.padlhub.app',
        sha256_cert_fingerprints: [...fingerprints],
      },
    },
  ];
}

function response(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status: init.status ?? 200,
    headers: init.headers ?? {},
  });
}

function routes(
  overrides: Record<string, () => Response> = {},
  fingerprints: readonly string[] = [DEBUG_CERT, RELEASE_CERT],
): (input: string) => Promise<Response> {
  const defaults: Record<string, () => Response> = {
    '/': () =>
      response('<!doctype html><html><body><div id="root"></div></body></html>', {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
    '/health/ready': () =>
      response(
        { status: 'ready', database: true, auth: true, communityMedia: true },
        { headers: { 'content-type': 'application/json' } },
      ),
    '/realtime/health/ready': () =>
      response({ status: 'ready' }, { headers: { 'content-type': 'application/json' } }),
    '/.well-known/assetlinks.json': () =>
      response(assetlinks(fingerprints), { headers: { 'content-type': 'application/json' } }),
    '/android/oauth/yandex': () =>
      response('<!doctype html><a href="padlhub://oauth/yandex?code=x">Открыть</a>', {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
      }),
  };
  const merged = { ...defaults, ...overrides };
  return (input: string) => {
    const path = new URL(input).pathname;
    const handler = merged[path];
    if (handler === undefined) return Promise.reject(new Error(`unexpected path ${path}`));
    return Promise.resolve(handler());
  };
}

function byId(checks: readonly CheckResult[], id: string): CheckResult {
  const check = checks.find((entry) => entry.id === id);
  if (check === undefined) throw new Error(`missing check ${id}`);
  return check;
}

describe('lk2 acceptance preflight', () => {
  it('parses the ru.padlhub.app fingerprints and rejects unusable files', () => {
    expect(parseAssetlinks(assetlinks([DEBUG_CERT]))).toEqual({
      packageName: 'ru.padlhub.app',
      fingerprints: [DEBUG_CERT],
    });
    expect(
      parseAssetlinks([
        {
          relation: [],
          target: {
            namespace: 'android_app',
            package_name: 'ru.padlhub.app',
            sha256_cert_fingerprints: [DEBUG_CERT.toLowerCase(), DEBUG_CERT],
          },
        },
      ]).fingerprints,
    ).toEqual([DEBUG_CERT]);
    expect(() => parseAssetlinks([])).toThrow('non-empty array');
    expect(() => parseAssetlinks({})).toThrow('non-empty array');
    expect(() =>
      parseAssetlinks([
        {
          relation: [],
          target: {
            namespace: 'web',
            package_name: 'ru.padlhub.app',
            sha256_cert_fingerprints: [DEBUG_CERT],
          },
        },
      ]),
    ).toThrow('namespace');
    expect(() =>
      parseAssetlinks([
        {
          relation: [],
          target: {
            namespace: 'android_app',
            package_name: 'com.example.app',
            sha256_cert_fingerprints: [DEBUG_CERT],
          },
        },
      ]),
    ).toThrow('package');
    expect(() =>
      parseAssetlinks([
        {
          relation: [],
          target: {
            namespace: 'android_app',
            package_name: 'ru.padlhub.app',
            sha256_cert_fingerprints: ['not-a-fingerprint'],
          },
        },
      ]),
    ).toThrow('malformed');
  });

  it('reports both directions of a fingerprint drift', () => {
    expect(compareFingerprints([DEBUG_CERT], [DEBUG_CERT, RELEASE_CERT])).toEqual({
      missing: [RELEASE_CERT],
      extra: [],
      matches: false,
    });
    expect(compareFingerprints([DEBUG_CERT, RELEASE_CERT], [DEBUG_CERT])).toEqual({
      missing: [],
      extra: [RELEASE_CERT],
      matches: false,
    });
    expect(compareFingerprints([DEBUG_CERT], [DEBUG_CERT.toLowerCase()])).toEqual({
      missing: [],
      extra: [],
      matches: true,
    });
  });

  it('passes every public check when the contour matches the repository', async () => {
    const checks = await runPreflight({
      baseUrl: BASE_URL,
      expectedFingerprints: [DEBUG_CERT, RELEASE_CERT],
      fetchImpl: routes(),
    });
    expect(checks.map((check) => [check.id, check.status])).toEqual([
      ['web.index', 'PASS'],
      ['web.health', 'PASS'],
      ['realtime.health', 'PASS'],
      ['web.assetlinks', 'PASS'],
      ['android.oauth', 'PASS'],
      ['dns.target', 'SKIP'],
    ]);
    expect(summarize(checks)).toEqual({ pass: 5, fail: 0, skip: 1, blocked: false });
  });

  it('blocks when the live assetlinks file lags the repository', async () => {
    const checks = await runPreflight({
      baseUrl: BASE_URL,
      expectedFingerprints: [DEBUG_CERT, RELEASE_CERT],
      fetchImpl: routes({}, [DEBUG_CERT]),
    });
    const assetlinksCheck = byId(checks, 'web.assetlinks');
    expect(assetlinksCheck.status).toBe('FAIL');
    expect(assetlinksCheck.detail).toContain(RELEASE_CERT);
    expect(assetlinksCheck.detail).toContain('promote');
    expect(summarize(checks).blocked).toBe(true);
  });

  it('fails the callback check without the browser fallback link', async () => {
    const checks = await runPreflight({
      baseUrl: BASE_URL,
      expectedFingerprints: [DEBUG_CERT],
      fetchImpl: routes({
        '/android/oauth/yandex': () =>
          response('<!doctype html><p>no fallback</p>', {
            headers: { 'content-type': 'text/html' },
          }),
      }),
    });
    const oauth = byId(checks, 'android.oauth');
    expect(oauth.status).toBe('FAIL');
    expect(oauth.detail).toContain('fallback');
    expect(oauth.detail).toContain('cache-control');
  });

  it('fails readiness and redirecting endpoints instead of assuming success', async () => {
    const checks = await runPreflight({
      baseUrl: BASE_URL,
      expectedFingerprints: [DEBUG_CERT],
      fetchImpl: routes({
        '/health/ready': () =>
          response(
            { status: 'starting', database: true, auth: false, communityMedia: false },
            { headers: { 'content-type': 'application/json' } },
          ),
        '/.well-known/assetlinks.json': () =>
          response('moved', { status: 302, headers: { location: 'https://elsewhere.example/' } }),
      }),
    });
    expect(byId(checks, 'web.health').status).toBe('FAIL');
    const assetlinksCheck = byId(checks, 'web.assetlinks');
    expect(assetlinksCheck.status).toBe('FAIL');
    expect(assetlinksCheck.detail).toContain('302');
  });

  it('turns network errors into failures without throwing', async () => {
    const checks = await runPreflight({
      baseUrl: BASE_URL,
      expectedFingerprints: [DEBUG_CERT],
      fetchImpl: () => Promise.reject(new Error('connect ECONNREFUSED')),
    });
    expect(checks.filter((check) => check.status === 'FAIL')).toHaveLength(5);
    expect(byId(checks, 'web.index').detail).toContain('ECONNREFUSED');
    expect(byId(checks, 'dns.target').status).toBe('SKIP');
  });

  it('checks the tracked host DNS record when the target contract applies', async () => {
    const matching = await runPreflight({
      baseUrl: BASE_URL,
      expectedFingerprints: [DEBUG_CERT],
      fetchImpl: routes(),
      target: { hostname: 'lk2.example', ipv4: '203.0.113.10' },
      resolveAddresses: () => Promise.resolve(['203.0.113.10']),
    });
    expect(byId(matching, 'dns.target').status).toBe('PASS');

    const drifted = await runPreflight({
      baseUrl: BASE_URL,
      expectedFingerprints: [DEBUG_CERT],
      fetchImpl: routes(),
      target: { hostname: 'lk2.example', ipv4: '203.0.113.10' },
      resolveAddresses: () => Promise.resolve(['198.51.100.7']),
    });
    const dns = byId(drifted, 'dns.target');
    expect(dns.status).toBe('FAIL');
    expect(dns.detail).toContain('198.51.100.7');

    const otherHost = await runPreflight({
      baseUrl: 'https://staging.example',
      expectedFingerprints: [DEBUG_CERT],
      fetchImpl: routes(),
      target: { hostname: 'lk2.example', ipv4: '203.0.113.10' },
      resolveAddresses: () => Promise.resolve(['203.0.113.10']),
    });
    expect(byId(otherHost, 'dns.target').status).toBe('SKIP');
  });

  it('parses the CLI arguments and rejects unknown flags', () => {
    expect(parseArguments([])).toMatchObject({ baseUrl: 'https://lk2.padlhub.su', json: false });
    expect(parseArguments(['--json'])).toMatchObject({ json: true });
    expect(parseArguments(['--base-url=https://example.test/path?x=1'])).toMatchObject({
      baseUrl: 'https://example.test/path?x=1',
    });
    expect(parseArguments(['--assetlinks=/tmp/assetlinks.json'])).toMatchObject({
      assetlinksPath: '/tmp/assetlinks.json',
    });
    expect(parseArguments(['--help'])).toMatchObject({ help: true });
    expect(() => parseArguments(['--target=lk2'])).toThrow('Unknown or invalid argument');
    expect(() => parseArguments(['--base-url='])).toThrow('Unknown or invalid argument');
  });

  it('renders a human report with the blocking decision', () => {
    const ready = renderReport(
      BASE_URL,
      [
        { id: 'web.index', status: 'PASS', detail: '200' },
        { id: 'dns.target', status: 'SKIP', detail: 'n/a' },
      ],
      new Date('2026-11-08T10:00:00.000Z'),
    );
    expect(ready).toContain('READY: 1 check(s) passed, 1 skipped');
    const blocked = renderReport(
      BASE_URL,
      [{ id: 'web.assetlinks', status: 'FAIL', detail: 'stale' }],
      new Date('2026-11-08T10:00:00.000Z'),
    );
    expect(blocked).toContain('BLOCKED: 1 check(s) failed');
    expect(blocked).toContain('docs/runbooks/lk2-acceptance.md');
  });

  it('returns non-zero for invalid input instead of running a check', async () => {
    expect(await main(['--nope'])).toBe(2);
    expect(await main(['--base-url=not-a-url'])).toBe(2);
    expect(await main(['--assetlinks=/definitely/missing.json'])).toBe(2);
    expect(await main(['--help'])).toBe(0);
  });
});
