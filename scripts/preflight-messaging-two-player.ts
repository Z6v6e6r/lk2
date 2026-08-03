import { pathToFileURL } from 'node:url';

export interface MessagingPreflightCheck {
  readonly name: string;
  readonly status: 'PASS' | 'BLOCKED' | 'NOT_CHECKED';
  readonly detail: string;
}

export interface MessagingPreflightReport {
  readonly result: 'HTTP_M1_PREFLIGHT_PASS' | 'BLOCKED';
  readonly checks: readonly MessagingPreflightCheck[];
  readonly mutationCount: 0;
}

export interface MessagingPreflightEnvironment {
  readonly MESSAGING_PREFLIGHT_BASE_URL?: string;
  readonly MESSAGING_PREFLIGHT_TENANT_KEY?: string;
  readonly MESSAGING_PREFLIGHT_EXPECTED_RELEASE?: string;
  readonly MESSAGING_PREFLIGHT_PLAYER_A_TOKEN?: string;
  readonly MESSAGING_PREFLIGHT_PLAYER_B_TOKEN?: string;
  readonly MESSAGING_PREFLIGHT_CONVERSATION_ID?: string;
  readonly MESSAGING_PREFLIGHT_REQUIRE_REALTIME?: string;
  readonly MESSAGING_PREFLIGHT_REALTIME_HEALTH_URL?: string;
}

interface JsonResponse {
  readonly status: number;
  readonly contentType: string;
  readonly cacheControl: string;
  readonly body: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function getJson(fetchImpl: typeof fetch, url: URL, token?: string): Promise<JsonResponse> {
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  const contentType = response.headers.get('content-type') ?? '';
  const body = contentType.toLowerCase().includes('application/json')
    ? ((await response.json()) as unknown)
    : undefined;
  return {
    status: response.status,
    contentType,
    cacheControl: response.headers.get('cache-control') ?? '',
    body,
  };
}

function pass(name: string, detail: string): MessagingPreflightCheck {
  return { name, status: 'PASS', detail };
}

function blocked(name: string, detail: string): MessagingPreflightCheck {
  return { name, status: 'BLOCKED', detail };
}

function notChecked(name: string, detail: string): MessagingPreflightCheck {
  return { name, status: 'NOT_CHECKED', detail };
}

function endpoint(baseUrl: string, path: string): URL {
  return new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
}

export async function runMessagingTwoPlayerPreflight(options: {
  readonly baseUrl: string;
  readonly tenantKey: string;
  readonly expectedRelease?: string;
  readonly playerAToken?: string;
  readonly playerBToken?: string;
  readonly conversationId?: string;
  readonly requireRealtime?: boolean;
  readonly realtimeHealthUrl?: string;
  readonly fetchImpl?: typeof fetch;
}): Promise<MessagingPreflightReport> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const checks: MessagingPreflightCheck[] = [];

  try {
    const manifest = await getJson(fetchImpl, endpoint(options.baseUrl, '/manifest.json'));
    const release = isRecord(manifest.body) ? manifest.body.release : undefined;
    if (!options.expectedRelease) {
      checks.push(blocked('immutable-release', 'MESSAGING_PREFLIGHT_EXPECTED_RELEASE is required'));
    } else if (manifest.status === 200 && release === options.expectedRelease) {
      checks.push(pass('immutable-release', `manifest release ${options.expectedRelease}`));
    } else {
      checks.push(blocked('immutable-release', 'manifest release does not match expected commit'));
    }
  } catch {
    checks.push(blocked('immutable-release', 'manifest request failed'));
  }

  try {
    const readiness = await getJson(fetchImpl, endpoint(options.baseUrl, '/health/ready'));
    const status = isRecord(readiness.body) ? readiness.body.status : undefined;
    checks.push(
      readiness.status === 200 && status === 'ready'
        ? pass('api-readiness', 'public readiness is ready')
        : blocked('api-readiness', 'public readiness is not ready JSON'),
    );
  } catch {
    checks.push(blocked('api-readiness', 'readiness request failed'));
  }

  const conversationsPath = `/user/api/v1/${encodeURIComponent(options.tenantKey)}/conversations?limit=1`;
  try {
    const routeProbe = await getJson(fetchImpl, endpoint(options.baseUrl, conversationsPath));
    const code = isRecord(routeProbe.body) ? routeProbe.body.code : undefined;
    checks.push(
      routeProbe.status === 401 && code === 'AUTH_REQUIRED'
        ? pass('messaging-route-mounted', 'anonymous request reached the authenticated M1 route')
        : blocked(
            'messaging-route-mounted',
            code === 'ROUTE_NOT_FOUND'
              ? 'M1 route is not mounted'
              : 'route did not return the expected AUTH_REQUIRED boundary',
          ),
    );
  } catch {
    checks.push(blocked('messaging-route-mounted', 'M1 route probe failed'));
  }

  for (const [name, token] of [
    ['player-a-conversations', options.playerAToken],
    ['player-b-conversations', options.playerBToken],
  ] as const) {
    if (!token) {
      checks.push(blocked(name, `${name} access token was not supplied through the environment`));
      continue;
    }
    try {
      const response = await getJson(
        fetchImpl,
        endpoint(options.baseUrl, conversationsPath),
        token,
      );
      const items = isRecord(response.body) ? response.body.items : undefined;
      checks.push(
        response.status === 200 &&
          Array.isArray(items) &&
          response.cacheControl.toLowerCase().includes('no-store')
          ? pass(name, 'authorized no-store conversation list is readable')
          : blocked(name, 'authorized conversation list is unavailable or cacheable'),
      );
    } catch {
      checks.push(blocked(name, 'authorized conversation list request failed'));
    }
  }

  if (!options.conversationId) {
    checks.push(
      blocked(
        'shared-conversation-history',
        'owner must supply an existing A/B conversation id or authorize a separate mutation window',
      ),
    );
  } else if (!options.playerAToken || !options.playerBToken) {
    checks.push(blocked('shared-conversation-history', 'both player tokens are required'));
  } else {
    const historyPath = `/user/api/v1/${encodeURIComponent(options.tenantKey)}/conversations/${encodeURIComponent(options.conversationId)}/messages?afterSequence=0&limit=1`;
    const historyResults = await Promise.allSettled(
      [options.playerAToken, options.playerBToken].map((token) =>
        getJson(fetchImpl, endpoint(options.baseUrl, historyPath), token),
      ),
    );
    const bothMembers = historyResults.every(
      (result) =>
        result.status === 'fulfilled' &&
        result.value.status === 200 &&
        result.value.cacheControl.toLowerCase().includes('no-store') &&
        isRecord(result.value.body) &&
        Array.isArray(result.value.body.messages),
    );
    checks.push(
      bothMembers
        ? pass('shared-conversation-history', 'both players can read the same existing history')
        : blocked('shared-conversation-history', 'both players are not proven active members'),
    );
  }

  if (!options.requireRealtime) {
    checks.push(
      notChecked(
        'realtime',
        'not required for HTTP M1 A-to-B acceptance; delivery uses refresh/poll',
      ),
    );
  } else if (!options.realtimeHealthUrl) {
    checks.push(blocked('realtime', 'realtime health URL is required for the M2 preflight'));
  } else {
    try {
      const response = await getJson(fetchImpl, new URL(options.realtimeHealthUrl));
      const body = isRecord(response.body) ? response.body : {};
      checks.push(
        response.status === 200 &&
          body.status === 'ready' &&
          body.redis === true &&
          body.database === true &&
          body.rabbit === true
          ? pass('realtime', 'dependency readiness passed; ticket/fanout E2E remains separate')
          : blocked('realtime', 'realtime dependency readiness failed'),
      );
    } catch {
      checks.push(blocked('realtime', 'realtime readiness request failed'));
    }
  }

  return {
    result: checks.some((check) => check.status === 'BLOCKED')
      ? 'BLOCKED'
      : 'HTTP_M1_PREFLIGHT_PASS',
    checks,
    mutationCount: 0,
  };
}

export function messagingPreflightOptionsFromEnvironment(
  environment: MessagingPreflightEnvironment,
): Parameters<typeof runMessagingTwoPlayerPreflight>[0] {
  const baseUrl = environment.MESSAGING_PREFLIGHT_BASE_URL;
  const tenantKey = environment.MESSAGING_PREFLIGHT_TENANT_KEY;
  const expectedRelease = environment.MESSAGING_PREFLIGHT_EXPECTED_RELEASE;
  if (!baseUrl) throw new Error('MESSAGING_PREFLIGHT_BASE_URL is required');
  if (!tenantKey) throw new Error('MESSAGING_PREFLIGHT_TENANT_KEY is required');
  if (!expectedRelease) throw new Error('MESSAGING_PREFLIGHT_EXPECTED_RELEASE is required');
  return {
    baseUrl,
    tenantKey,
    expectedRelease,
    ...(environment.MESSAGING_PREFLIGHT_PLAYER_A_TOKEN
      ? { playerAToken: environment.MESSAGING_PREFLIGHT_PLAYER_A_TOKEN }
      : {}),
    ...(environment.MESSAGING_PREFLIGHT_PLAYER_B_TOKEN
      ? { playerBToken: environment.MESSAGING_PREFLIGHT_PLAYER_B_TOKEN }
      : {}),
    ...(environment.MESSAGING_PREFLIGHT_CONVERSATION_ID
      ? { conversationId: environment.MESSAGING_PREFLIGHT_CONVERSATION_ID }
      : {}),
    requireRealtime: environment.MESSAGING_PREFLIGHT_REQUIRE_REALTIME === 'true',
    ...(environment.MESSAGING_PREFLIGHT_REALTIME_HEALTH_URL
      ? { realtimeHealthUrl: environment.MESSAGING_PREFLIGHT_REALTIME_HEALTH_URL }
      : {}),
  };
}

async function main(): Promise<void> {
  const report = await runMessagingTwoPlayerPreflight(
    messagingPreflightOptionsFromEnvironment(process.env),
  );
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.result === 'BLOCKED') process.exitCode = 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}
