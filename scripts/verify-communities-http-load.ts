import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import { readPrivateFixture, requirePinnedOrigin } from './communities-private-fixture.js';

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function boundedInteger(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

const authFixtureSchema = z
  .object({
    expectedOrigin: z.string().url(),
    tokens: z.array(z.string().min(32)).min(1).max(1_000),
    communityIds: z.array(z.string().uuid()).min(1).max(1_000),
    contentTargets: z
      .array(
        z
          .object({
            communityId: z.string().uuid(),
            postId: z.string().uuid(),
          })
          .strict(),
      )
      .min(1)
      .max(1_000),
    searchQuery: z.string().min(2).max(80).default('padel'),
  })
  .strict();

const baseUrl = new URL(requiredEnvironment('COMMUNITIES_HTTP_BASE_URL'));
const isLoopback = ['127.0.0.1', 'localhost', '::1'].includes(baseUrl.hostname);
if (baseUrl.protocol !== 'https:' && !(baseUrl.protocol === 'http:' && isLoopback)) {
  throw new Error('COMMUNITIES_HTTP_BASE_URL must use HTTPS unless it is a loopback target');
}
baseUrl.pathname = baseUrl.pathname.replace(/\/$/, '');
baseUrl.search = '';
baseUrl.hash = '';
const tenantKey = requiredEnvironment('COMMUNITIES_HTTP_TENANT_KEY');
if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(tenantKey)) {
  throw new Error('COMMUNITIES_HTTP_TENANT_KEY is invalid');
}
const fixture = authFixtureSchema.parse(
  JSON.parse(
    await readPrivateFixture(
      requiredEnvironment('COMMUNITIES_HTTP_AUTH_FILE'),
      'COMMUNITIES_HTTP_AUTH_FILE',
    ),
  ),
);
requirePinnedOrigin(baseUrl, fixture.expectedOrigin, 'COMMUNITIES_HTTP_BASE_URL');

const requests = boundedInteger('COMMUNITIES_HTTP_REQUESTS', 5_000, 100, 100_000);
const concurrency = boundedInteger('COMMUNITIES_HTTP_CONCURRENCY', 40, 1, 500);
const timeoutMs = boundedInteger('COMMUNITIES_HTTP_TIMEOUT_MS', 5_000, 100, 30_000);
const minimumRps = boundedInteger('COMMUNITIES_HTTP_MIN_RPS', 750, 1, 20_000);
const readP95TargetMs = boundedInteger('COMMUNITIES_HTTP_READ_P95_TARGET_MS', 250, 10, 10_000);
const readP99TargetMs = boundedInteger('COMMUNITIES_HTTP_READ_P99_TARGET_MS', 600, 10, 30_000);
const maxErrorPermille = boundedInteger('COMMUNITIES_HTTP_MAX_ERROR_PERMILLE', 1, 0, 100);
const payloadBudgetBytes = boundedInteger(
  'COMMUNITIES_HTTP_PAYLOAD_BUDGET_BYTES',
  100_000,
  1_000,
  1_000_000,
);

type Journey = 'directory' | 'mine' | 'detail' | 'search' | 'feed' | 'comments' | 'recovery';

interface Measurement {
  readonly journey: Journey;
  readonly durationMs: number;
  readonly payloadBytes: number;
  readonly ok: boolean;
  readonly status: number | null;
  readonly failureCode?: string;
}

function percentile(values: readonly number[], quantile: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1);
  return sorted[index] ?? 0;
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}

function journeyFor(index: number): Journey {
  const bucket = index % 100;
  if (bucket < 30) return 'directory';
  if (bucket < 45) return 'mine';
  if (bucket < 60) return 'detail';
  if (bucket < 70) return 'search';
  if (bucket < 85) return 'feed';
  if (bucket < 95) return 'comments';
  return 'recovery';
}

function requestUrl(journey: Journey, index: number): URL {
  const prefix = `/user/api/v1/${encodeURIComponent(tenantKey)}/communities`;
  const url = new URL(baseUrl);
  if (journey === 'mine') {
    url.pathname = `${baseUrl.pathname}${prefix}/mine`;
    url.searchParams.set('limit', '20');
    return url;
  }
  if (journey === 'detail') {
    const communityId = fixture.communityIds[index % fixture.communityIds.length];
    if (!communityId) throw new Error('HTTP load community fixture is missing');
    url.pathname = `${baseUrl.pathname}${prefix}/${communityId}`;
    return url;
  }
  if (journey === 'feed' || journey === 'comments' || journey === 'recovery') {
    const target = fixture.contentTargets[index % fixture.contentTargets.length];
    if (!target) throw new Error('HTTP content load fixture is missing');
    const base = `${baseUrl.pathname}${prefix}/${target.communityId}`;
    url.pathname =
      journey === 'feed'
        ? `${base}/feed`
        : journey === 'comments'
          ? `${base}/posts/${target.postId}/comments`
          : `${base}/events`;
    url.searchParams.set('limit', journey === 'recovery' ? '50' : '20');
    if (journey === 'recovery') url.searchParams.set('afterSequence', '0');
    return url;
  }
  url.pathname = `${baseUrl.pathname}${prefix}`;
  url.searchParams.set('limit', '20');
  if (journey === 'search') url.searchParams.set('query', fixture.searchQuery);
  return url;
}

async function performRequest(index: number): Promise<Measurement> {
  const journey = journeyFor(index);
  const token = fixture.tokens[index % fixture.tokens.length];
  if (!token) throw new Error('HTTP load token fixture is missing');
  const correlationId = randomUUID();
  const started = performance.now();
  try {
    const response = await fetch(requestUrl(journey, index), {
      method: 'GET',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${token}`,
        'x-correlation-id': correlationId,
      },
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const payload = new Uint8Array(await response.arrayBuffer());
    return {
      journey,
      durationMs: performance.now() - started,
      payloadBytes: payload.byteLength,
      ok: response.status === 200 && payload.byteLength <= payloadBudgetBytes,
      status: response.status,
      ...(response.status === 200
        ? payload.byteLength <= payloadBudgetBytes
          ? {}
          : { failureCode: 'PAYLOAD_BUDGET_EXCEEDED' }
        : { failureCode: `HTTP_${response.status}` }),
    };
  } catch (error: unknown) {
    return {
      journey,
      durationMs: performance.now() - started,
      payloadBytes: 0,
      ok: false,
      status: null,
      failureCode:
        error instanceof Error && error.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK_ERROR',
    };
  }
}

async function runMeasurements(total: number, offset: number): Promise<Measurement[]> {
  const results: Measurement[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, total) }, async () => {
      while (true) {
        const index = next;
        next += 1;
        if (index >= total) return;
        results.push(await performRequest(offset + index));
      }
    }),
  );
  return results;
}

await runMeasurements(Math.min(100, fixture.tokens.length * 4), 1_000_000);
const started = performance.now();
const measurements = await runMeasurements(requests, 0);
const durationMs = performance.now() - started;
const failed = measurements.filter((measurement) => !measurement.ok);
const allowedErrors = Math.floor((requests * maxErrorPermille) / 1_000);
const throughputRps = (measurements.length * 1_000) / durationMs;

const journeyResults = Object.fromEntries(
  (['directory', 'mine', 'detail', 'search', 'feed', 'comments', 'recovery'] as const).map(
    (journey) => {
      const values = measurements.filter((measurement) => measurement.journey === journey);
      const durations = values.map((measurement) => measurement.durationMs);
      return [
        journey,
        {
          requests: values.length,
          errors: values.filter((measurement) => !measurement.ok).length,
          p50Ms: rounded(percentile(durations, 0.5)),
          p95Ms: rounded(percentile(durations, 0.95)),
          p99Ms: rounded(percentile(durations, 0.99)),
          maxMs: rounded(Math.max(...durations)),
          maxPayloadBytes: Math.max(...values.map((measurement) => measurement.payloadBytes)),
        },
      ];
    },
  ),
);

const failedJourneys = Object.entries(journeyResults).filter(
  ([, result]) => result.p95Ms > readP95TargetMs || result.p99Ms > readP99TargetMs,
);
if (failed.length > allowedErrors || throughputRps < minimumRps || failedJourneys.length > 0) {
  throw new Error(
    `Communities HTTP load gate failed: ${JSON.stringify({
      requests,
      errors: failed.length,
      allowedErrors,
      errorCodes: Object.fromEntries(
        [...new Set(failed.map((measurement) => measurement.failureCode ?? 'UNKNOWN'))].map(
          (code) => [code, failed.filter((measurement) => measurement.failureCode === code).length],
        ),
      ),
      throughputRps: rounded(throughputRps),
      minimumRps,
      readP95TargetMs,
      readP99TargetMs,
      failedJourneys: failedJourneys.map(([journey]) => journey),
      journeyResults,
    })}`,
  );
}

process.stdout.write(
  `${JSON.stringify({
    status: 'passed',
    target: `${baseUrl.protocol}//${baseUrl.host}${baseUrl.pathname}`,
    tenantKey,
    requests,
    concurrency,
    authPrincipals: fixture.tokens.length,
    detailCommunities: fixture.communityIds.length,
    contentTargets: fixture.contentTargets.length,
    durationMs: rounded(durationMs),
    throughputRps: rounded(throughputRps),
    errors: failed.length,
    allowedErrors,
    targets: { minimumRps, readP95TargetMs, readP99TargetMs, payloadBudgetBytes },
    trafficShape: {
      directoryPercent: 30,
      minePercent: 15,
      detailPercent: 15,
      searchPercent: 10,
      feedPercent: 15,
      commentsPercent: 10,
      recoveryPercent: 5,
    },
    journeyResults,
  })}\n`,
);
