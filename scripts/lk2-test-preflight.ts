// Read-only acceptance preflight for the LK2 test contour (default https://lk2.padlhub.su).
//
// Every check is a public HTTPS GET plus one optional DNS A lookup: no credential is used and
// nothing is written. Run it before and after the owner-approved beta-lane promote described in
// docs/runbooks/lk2-acceptance.md — a FAIL names the exact remaining owner step.
//
//   npm run lk2:preflight
//   npm run lk2:preflight -- --json
//   npm run lk2:preflight -- --base-url=https://lk2.padlhub.su
import { resolve4 } from 'node:dns/promises';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export type CheckStatus = 'PASS' | 'FAIL' | 'SKIP';

export interface CheckResult {
  readonly id: string;
  readonly status: CheckStatus;
  readonly detail: string;
}

export interface PreflightTarget {
  readonly hostname: string;
  readonly ipv4: string;
}

export interface PreflightOptions {
  readonly baseUrl: string;
  readonly expectedFingerprints: readonly string[];
  readonly fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  readonly target?: PreflightTarget;
  readonly resolveAddresses?: (hostname: string) => Promise<readonly string[]>;
  readonly timeoutMs?: number;
}

export interface PreflightSummary {
  readonly pass: number;
  readonly fail: number;
  readonly skip: number;
  readonly blocked: boolean;
}

export interface CliOptions {
  readonly baseUrl: string;
  readonly json: boolean;
  readonly assetlinksPath?: string;
  readonly help: boolean;
}

const DEFAULT_BASE_URL = 'https://lk2.padlhub.su';
const DEFAULT_TIMEOUT_MS = 15_000;
const ASSETLINKS_PATH = '/.well-known/assetlinks.json';
const OAUTH_PATH = '/android/oauth/yandex';
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPOSITORY_ASSETLINKS = 'apps/web/public/.well-known/assetlinks.json';
const REPOSITORY_TARGET = 'deploy/timeweb/target.json';
const ACCEPTANCE_RUNBOOK = 'docs/runbooks/lk2-acceptance.md';

export function normalizeFingerprint(value: string): string {
  return value.replace(/\s+/g, '').toUpperCase();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Extracts the cert fingerprints for ru.padlhub.app from an assetlinks payload. The whole file is
 * rejected when any entry is not a usable android_app target for that package: a partly valid file
 * that silently hides a stale association is worse than a loud preflight failure.
 */
export function parseAssetlinks(payload: unknown): { packageName: string; fingerprints: string[] } {
  if (!Array.isArray(payload) || payload.length === 0) {
    throw new Error('assetlinks.json is not a non-empty array');
  }
  const fingerprints = new Set<string>();
  let packageName: string | undefined;
  for (const entry of payload) {
    if (!isRecord(entry)) throw new Error('assetlinks.json entry is not an object');
    const target = entry.target;
    if (!isRecord(target)) throw new Error('assetlinks.json entry has no target object');
    if (target.namespace !== 'android_app') {
      throw new Error('assetlinks.json target namespace is not android_app');
    }
    if (target.package_name !== 'ru.padlhub.app') {
      throw new Error('assetlinks.json target package is not ru.padlhub.app');
    }
    packageName = target.package_name;
    const list = target.sha256_cert_fingerprints;
    if (!Array.isArray(list) || list.length === 0) {
      throw new Error('assetlinks.json target has no sha256_cert_fingerprints');
    }
    for (const value of list) {
      if (
        typeof value !== 'string' ||
        !/^[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){31}$/.test(value.trim())
      ) {
        throw new Error('assetlinks.json contains a malformed cert fingerprint');
      }
      fingerprints.add(normalizeFingerprint(value));
    }
  }
  if (packageName === undefined) throw new Error('assetlinks.json has no ru.padlhub.app target');
  return { packageName, fingerprints: [...fingerprints].sort() };
}

export interface FingerprintDiff {
  readonly missing: readonly string[];
  readonly extra: readonly string[];
  readonly matches: boolean;
}

export function compareFingerprints(
  live: readonly string[],
  expected: readonly string[],
): FingerprintDiff {
  const liveSet = new Set(live.map(normalizeFingerprint));
  const expectedSet = new Set(expected.map(normalizeFingerprint));
  const missing = [...expectedSet].filter((value) => !liveSet.has(value)).sort();
  const extra = [...liveSet].filter((value) => !expectedSet.has(value)).sort();
  return { missing, extra, matches: missing.length === 0 && extra.length === 0 };
}

export function summarize(checks: readonly CheckResult[]): PreflightSummary {
  const pass = checks.filter((check) => check.status === 'PASS').length;
  const fail = checks.filter((check) => check.status === 'FAIL').length;
  const skip = checks.filter((check) => check.status === 'SKIP').length;
  return { pass, fail, skip, blocked: fail > 0 };
}

export function renderReport(baseUrl: string, checks: readonly CheckResult[], now: Date): string {
  const lines = [`LK2 acceptance preflight — ${baseUrl} — ${now.toISOString()}`, ''];
  for (const check of checks) {
    lines.push(`${check.status.padEnd(5)} ${check.id.padEnd(16)} ${check.detail}`);
  }
  const summary = summarize(checks);
  lines.push('');
  lines.push(
    summary.blocked
      ? `BLOCKED: ${summary.fail} check(s) failed, ${summary.pass} passed, ${summary.skip} skipped. Fix the failing owner step in ${ACCEPTANCE_RUNBOOK} and rerun.`
      : `READY: ${summary.pass} check(s) passed, ${summary.skip} skipped. Follow the manual matrix in ${ACCEPTANCE_RUNBOOK}.`,
  );
  return lines.join('\n');
}

function hostOf(baseUrl: string): string {
  return new URL(baseUrl).host.replace(/:\d+$/, '');
}

export function parseArguments(argv: readonly string[]): CliOptions {
  const options: { baseUrl: string; json: boolean; assetlinksPath?: string; help: boolean } = {
    baseUrl: DEFAULT_BASE_URL,
    json: false,
    help: false,
  };
  for (const arg of argv) {
    const separator = arg.indexOf('=');
    const key = separator === -1 ? arg : arg.slice(0, separator);
    const value = separator === -1 ? undefined : arg.slice(separator + 1);
    if (key === '--json' && value === undefined) options.json = true;
    else if (key === '--help' && value === undefined) options.help = true;
    else if (key === '--base-url' && value !== undefined && value !== '') options.baseUrl = value;
    else if (key === '--assetlinks' && value !== undefined && value !== '')
      options.assetlinksPath = value;
    else throw new Error(`Unknown or invalid argument: ${arg}`);
  }
  return options;
}

async function readExpectedFingerprints(path: string): Promise<string[]> {
  const payload: unknown = JSON.parse(await readFile(path, 'utf8'));
  return parseAssetlinks(payload).fingerprints;
}

async function readTarget(root: string): Promise<PreflightTarget | undefined> {
  try {
    const payload: unknown = JSON.parse(await readFile(resolve(root, REPOSITORY_TARGET), 'utf8'));
    if (!isRecord(payload)) return undefined;
    const hostname = payload.hostname;
    const ipv4 = payload.ipv4;
    if (typeof hostname !== 'string' || typeof ipv4 !== 'string') return undefined;
    return { hostname, ipv4 };
  } catch {
    return undefined;
  }
}

export async function runPreflight(options: PreflightOptions): Promise<CheckResult[]> {
  const fetchImpl =
    options.fetchImpl ?? ((input: string, init?: RequestInit) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const checks: CheckResult[] = [];

  const request = async (path: string): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetchImpl(`${baseUrl}${path}`, {
        method: 'GET',
        redirect: 'manual',
        headers: { 'User-Agent': 'phub-lk2-preflight' },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  };

  const attempt = async (id: string, check: () => Promise<CheckResult>): Promise<CheckResult> => {
    try {
      return await check();
    } catch (error) {
      return { id, status: 'FAIL', detail: `request failed: ${errorMessage(error)}` };
    }
  };

  checks.push(
    await attempt('web.index', async () => {
      const response = await request('/');
      if (response.status !== 200) {
        return { id: 'web.index', status: 'FAIL', detail: `expected 200, got ${response.status}` };
      }
      const contentType = response.headers.get('content-type') ?? '';
      const body = await response.text();
      if (!contentType.includes('text/html')) {
        return {
          id: 'web.index',
          status: 'FAIL',
          detail: `unexpected content-type ${contentType}`,
        };
      }
      if (body.trim() === '') {
        return { id: 'web.index', status: 'FAIL', detail: 'empty HTML document' };
      }
      return {
        id: 'web.index',
        status: 'PASS',
        detail: `200 ${contentType}; ${body.length} bytes`,
      };
    }),
  );

  checks.push(
    await attempt('web.health', async () => {
      const response = await request('/health/ready');
      if (response.status !== 200) {
        return {
          id: 'web.health',
          status: 'FAIL',
          detail: `expected 200, got ${response.status}`,
        };
      }
      const payload: unknown = await response.json();
      if (!isRecord(payload) || payload.status !== 'ready') {
        return {
          id: 'web.health',
          status: 'FAIL',
          detail: `status is not ready: ${JSON.stringify(payload)}`,
        };
      }
      const database = payload.database === true;
      const auth = payload.auth === true;
      const communityMedia = payload.communityMedia === true;
      if (!database || !auth) {
        return {
          id: 'web.health',
          status: 'FAIL',
          detail: `database=${database} auth=${auth} communityMedia=${communityMedia}`,
        };
      }
      return {
        id: 'web.health',
        status: 'PASS',
        detail: `ready; database=${database} auth=${auth} communityMedia=${communityMedia}`,
      };
    }),
  );

  checks.push(
    await attempt('realtime.health', async () => {
      const response = await request('/realtime/health/ready');
      if (response.status !== 200) {
        return {
          id: 'realtime.health',
          status: 'FAIL',
          detail: `expected 200, got ${response.status}`,
        };
      }
      return { id: 'realtime.health', status: 'PASS', detail: '200' };
    }),
  );

  checks.push(
    await attempt('web.assetlinks', async () => {
      const response = await request(ASSETLINKS_PATH);
      if (response.status !== 200) {
        const location = response.headers.get('location');
        return {
          id: 'web.assetlinks',
          status: 'FAIL',
          detail: `expected 200, got ${response.status}${location === null ? '' : ` -> ${location}`}`,
        };
      }
      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.includes('application/json')) {
        return {
          id: 'web.assetlinks',
          status: 'FAIL',
          detail: `unexpected content-type ${contentType}`,
        };
      }
      const payload: unknown = await response.json();
      const live = parseAssetlinks(payload);
      const diff = compareFingerprints(live.fingerprints, options.expectedFingerprints);
      if (!diff.matches) {
        const parts: string[] = [];
        if (diff.missing.length > 0) parts.push(`missing ${diff.missing.join(', ')}`);
        if (diff.extra.length > 0) parts.push(`unexpected ${diff.extra.join(', ')}`);
        return {
          id: 'web.assetlinks',
          status: 'FAIL',
          detail: `live file does not match ${REPOSITORY_ASSETLINKS}: ${parts.join('; ')} — the owner-approved promote to the current main is pending`,
        };
      }
      return {
        id: 'web.assetlinks',
        status: 'PASS',
        detail: `${live.packageName}; ${live.fingerprints.length} fingerprint(s) match ${REPOSITORY_ASSETLINKS}`,
      };
    }),
  );

  checks.push(
    await attempt('android.oauth', async () => {
      const response = await request(OAUTH_PATH);
      if (response.status !== 200) {
        return {
          id: 'android.oauth',
          status: 'FAIL',
          detail: `expected 200, got ${response.status}`,
        };
      }
      const location = response.headers.get('location');
      if (location !== null) {
        return {
          id: 'android.oauth',
          status: 'FAIL',
          detail: `expected a static page without redirect, got Location: ${location}`,
        };
      }
      const contentType = response.headers.get('content-type') ?? '';
      const cacheControl = response.headers.get('cache-control') ?? '';
      const body = await response.text();
      const problems: string[] = [];
      if (!contentType.includes('text/html')) problems.push(`content-type ${contentType}`);
      if (!cacheControl.includes('no-store')) problems.push(`cache-control ${cacheControl}`);
      if (!body.includes('padlhub://oauth/yandex')) problems.push('browser fallback link missing');
      if (problems.length > 0) {
        return { id: 'android.oauth', status: 'FAIL', detail: problems.join('; ') };
      }
      return {
        id: 'android.oauth',
        status: 'PASS',
        detail: '200 text/html, no-store, browser fallback present',
      };
    }),
  );

  const target = options.target;
  if (target === undefined) {
    checks.push({ id: 'dns.target', status: 'SKIP', detail: 'no target contract available' });
  } else if (hostOf(baseUrl) !== target.hostname) {
    checks.push({
      id: 'dns.target',
      status: 'SKIP',
      detail: `${hostOf(baseUrl)} is not the tracked target ${target.hostname}`,
    });
  } else if (options.resolveAddresses === undefined) {
    checks.push({ id: 'dns.target', status: 'SKIP', detail: 'DNS resolver not supplied' });
  } else {
    const resolveAddresses = options.resolveAddresses;
    checks.push(
      await attempt('dns.target', async () => {
        const addresses = await resolveAddresses(target.hostname);
        if (!addresses.includes(target.ipv4)) {
          return {
            id: 'dns.target',
            status: 'FAIL',
            detail: `${target.hostname} resolves to ${addresses.join(', ')} instead of ${target.ipv4}`,
          };
        }
        return {
          id: 'dns.target',
          status: 'PASS',
          detail: `${target.hostname} -> ${target.ipv4}`,
        };
      }),
    );
  }

  return checks;
}

export async function main(argv: readonly string[], now: Date = new Date()): Promise<number> {
  let options: CliOptions;
  try {
    options = parseArguments(argv);
  } catch (error) {
    console.error(`lk2:preflight: ${errorMessage(error)}`);
    return 2;
  }
  if (options.help) {
    console.log(
      'Usage: npm run lk2:preflight -- [--base-url=<url>] [--assetlinks=<path>] [--json]',
    );
    return 0;
  }
  try {
    if (hostOf(options.baseUrl) === '') throw new Error('empty host');
  } catch {
    console.error('lk2:preflight: --base-url must be an absolute URL');
    return 2;
  }

  const assetlinksPath = options.assetlinksPath ?? resolve(REPOSITORY_ROOT, REPOSITORY_ASSETLINKS);
  let expectedFingerprints: string[];
  try {
    expectedFingerprints = await readExpectedFingerprints(assetlinksPath);
  } catch (error) {
    console.error(`lk2:preflight: cannot read ${assetlinksPath}: ${errorMessage(error)}`);
    return 2;
  }
  const target = await readTarget(REPOSITORY_ROOT);
  const checks = await runPreflight({
    baseUrl: options.baseUrl,
    expectedFingerprints,
    ...(target === undefined ? {} : { target }),
    resolveAddresses: async (hostname) => resolve4(hostname),
  });
  const summary = summarize(checks);
  if (options.json) {
    console.log(
      JSON.stringify(
        {
          baseUrl: options.baseUrl,
          generatedAt: now.toISOString(),
          checks,
          summary,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(renderReport(options.baseUrl, checks, now));
  }
  return summary.blocked ? 1 : 0;
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath !== undefined && pathToFileURL(invokedPath).href === import.meta.url) {
  process.exitCode = await main(process.argv.slice(2));
}
