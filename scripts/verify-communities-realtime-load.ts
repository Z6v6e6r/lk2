import { performance } from 'node:perf_hooks';

import WebSocket, { type RawData } from 'ws';

import {
  evaluateRealtimeLoadAssertions,
  matchesExpectedRealtimeEvent,
  realtimeLoadFixtureSchema,
  resolveRealtimeLoadPolicy,
  type RealtimeConnectionGateObservation,
  type RealtimeLoadFixture,
} from './communities-realtime-load-support.js';
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

const endpoint = new URL(requiredEnvironment('COMMUNITIES_REALTIME_URL'));
const loopback = ['127.0.0.1', 'localhost', '::1'].includes(endpoint.hostname);
if (endpoint.protocol !== 'wss:' && !(endpoint.protocol === 'ws:' && loopback)) {
  throw new Error('COMMUNITIES_REALTIME_URL must use WSS unless it is a loopback target');
}
const fixture = realtimeLoadFixtureSchema.parse(
  JSON.parse(
    await readPrivateFixture(
      requiredEnvironment('COMMUNITIES_REALTIME_AUTH_FILE'),
      'COMMUNITIES_REALTIME_AUTH_FILE',
      32 * 1024 * 1024,
    ),
  ),
);
requirePinnedOrigin(endpoint, fixture.expectedOrigin, 'COMMUNITIES_REALTIME_URL');
const policy = resolveRealtimeLoadPolicy({ loopback });
const connectionCount = boundedInteger(
  'COMMUNITIES_REALTIME_CONNECTIONS',
  fixture.connections.length,
  1,
  fixture.connections.length,
);
const rampConcurrency = boundedInteger('COMMUNITIES_REALTIME_RAMP_CONCURRENCY', 100, 1, 1_000);
const reconnectConcurrency = boundedInteger(
  'COMMUNITIES_REALTIME_RECONNECT_CONCURRENCY',
  1_000,
  1,
  1_000,
);
const timeoutMs = boundedInteger('COMMUNITIES_REALTIME_TIMEOUT_MS', 10_000, 1_000, 60_000);
const slowClientResumeMs = boundedInteger(
  'COMMUNITIES_REALTIME_SLOW_CLIENT_RESUME_MS',
  Math.max(1_000, Math.min(60_000, policy.holdMs - 1_000)),
  1_000,
  Math.max(1_000, policy.holdMs - 1_000),
);
const connectionP95TargetMs = boundedInteger(
  'COMMUNITIES_REALTIME_CONNECTION_P95_TARGET_MS',
  3_000,
  100,
  30_000,
);
const eventP95TargetMs = boundedInteger(
  'COMMUNITIES_REALTIME_EVENT_P95_TARGET_MS',
  1_000,
  10,
  30_000,
);
const eventP99TargetMs = boundedInteger(
  'COMMUNITIES_REALTIME_EVENT_P99_TARGET_MS',
  3_000,
  10,
  60_000,
);

function text(raw: RawData): string {
  if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8');
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf8');
  return raw.toString('utf8');
}

function percentile(values: readonly number[], quantile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)] ?? 0;
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}

interface LiveConnection {
  readonly index: number;
  readonly socket: WebSocket;
  readonly readyMs: number;
  readonly subscribedMs: number;
  expectedEventDeliveries: number;
  readonly eventLatencies: number[];
  closedUnexpectedly: boolean;
  unauthorizedDeliveries: number;
  readonly deniedSubscriptionRequired: boolean;
  deniedSubscriptionVerified: boolean;
  readonly slowClient: boolean;
  slowClientCloseCode?: number;
  expectedClose: boolean;
  resumeSlowClient?: () => void;
}

type FixtureConnection = RealtimeLoadFixture['connections'][number];

function socketTransport(socket: WebSocket): { pause(): void; resume(): void } | undefined {
  return (socket as WebSocket & { _socket?: { pause(): void; resume(): void } })._socket;
}

async function openConnection(
  index: number,
  entry: FixtureConnection,
  ticket: string,
): Promise<LiveConnection> {
  const started = performance.now();
  return new Promise((resolvePromise, rejectPromise) => {
    const socket = new WebSocket(endpoint, { handshakeTimeout: timeoutMs });
    let readyAt = 0;
    let settled = false;
    let subscribed = false;
    let connection: LiveConnection | undefined;
    const timer = setTimeout(() => {
      socket.terminate();
      rejectPromise(new Error('Realtime connection timed out'));
    }, timeoutMs);
    const fail = (error: Error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        rejectPromise(error);
      }
    };
    socket.once('error', fail);
    socket.once('open', () => {
      socket.send(JSON.stringify({ type: 'authenticate', ticket }));
    });
    socket.on('message', (raw) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(text(raw)) as Record<string, unknown>;
      } catch {
        fail(new Error('Realtime server returned malformed JSON'));
        return;
      }
      if (message.type === 'connection.ready') {
        readyAt = performance.now();
        socket.send(
          JSON.stringify({ type: 'community.subscribe', communityId: entry.communityId }),
        );
        return;
      }
      if (
        message.type === 'community.subscribed' &&
        message.communityId === entry.communityId &&
        !subscribed
      ) {
        subscribed = true;
        connection = {
          index,
          socket,
          readyMs: readyAt - started,
          subscribedMs: performance.now() - started,
          expectedEventDeliveries: 0,
          eventLatencies: [],
          closedUnexpectedly: false,
          unauthorizedDeliveries: 0,
          deniedSubscriptionRequired: entry.deniedCommunityId !== undefined,
          deniedSubscriptionVerified: false,
          slowClient: entry.slowClient,
          expectedClose: false,
        };
        if (entry.deniedCommunityId) {
          socket.send(
            JSON.stringify({
              type: 'community.subscribe',
              communityId: entry.deniedCommunityId,
            }),
          );
          return;
        }
        settled = true;
        clearTimeout(timer);
        if (entry.slowClient) {
          const transport = socketTransport(socket);
          if (!transport) return fail(new Error('Slow-client transport is unavailable'));
          transport.pause();
          connection.resumeSlowClient = () => transport.resume();
        }
        resolvePromise(connection);
        return;
      }
      if (
        message.type === 'community.subscribed' &&
        entry.deniedCommunityId &&
        message.communityId === entry.deniedCommunityId
      ) {
        fail(new Error('Denied Community subscription succeeded'));
        return;
      }
      if (message.type === 'error') {
        if (
          connection &&
          entry.deniedCommunityId &&
          message.code === 'COMMUNITY_NOT_FOUND' &&
          message.communityId === entry.deniedCommunityId
        ) {
          connection.deniedSubscriptionVerified = true;
          settled = true;
          clearTimeout(timer);
          if (entry.slowClient) {
            const transport = socketTransport(socket);
            if (!transport) return fail(new Error('Slow-client transport is unavailable'));
            transport.pause();
            connection.resumeSlowClient = () => transport.resume();
          }
          resolvePromise(connection);
          return;
        }
        fail(new Error(`Realtime protocol error: ${String(message.code)}`));
        return;
      }
      if (message.type === 'community.event' && connection) {
        if (message.communityId !== entry.communityId) {
          connection.unauthorizedDeliveries += 1;
        }
        if (!matchesExpectedRealtimeEvent(message, fixture.expectedEvent)) return;
        connection.expectedEventDeliveries += 1;
        const occurredAt =
          typeof message.occurredAt === 'string' ? Date.parse(message.occurredAt) : NaN;
        if (Number.isFinite(occurredAt)) connection.eventLatencies.push(Date.now() - occurredAt);
      }
    });
    socket.once('close', (code) => {
      if (connection) {
        if (connection.slowClient) connection.slowClientCloseCode = code;
        if (!connection.expectedClose && !(connection.slowClient && code === 1013)) {
          connection.closedUnexpectedly = true;
        }
      }
      fail(new Error(`Realtime connection closed with ${code}`));
    });
  });
}

const connections = Array<LiveConnection | undefined>(connectionCount).fill(undefined);
const allConnections: LiveConnection[] = [];
let cursor = 0;
const rampStarted = performance.now();
let reconnects = 0;
let reconnectRatePerSecond = 0;
try {
  await Promise.all(
    Array.from({ length: Math.min(connectionCount, rampConcurrency) }, async () => {
      while (true) {
        const index = cursor;
        cursor += 1;
        if (index >= connectionCount) return;
        const entry = fixture.connections[index];
        if (!entry) throw new Error('Realtime fixture entry is missing');
        const connection = await openConnection(index, entry, entry.ticket);
        connections[index] = connection;
        allConnections.push(connection);
      }
    }),
  );
  const rampDurationMs = performance.now() - rampStarted;
  const reconnectIndices = fixture.connections
    .slice(0, connectionCount)
    .map((entry, index) => (entry.reconnectTicket ? index : -1))
    .filter((index) => index >= 0);
  if (reconnectIndices.length > 0) {
    let reconnectCursor = 0;
    const reconnectStarted = performance.now();
    await Promise.all(
      Array.from({ length: Math.min(reconnectIndices.length, reconnectConcurrency) }, async () => {
        while (true) {
          const reconnectOffset = reconnectCursor;
          reconnectCursor += 1;
          const index = reconnectIndices[reconnectOffset];
          if (index === undefined) return;
          const previous = connections[index];
          const entry = fixture.connections[index];
          if (!previous || !entry?.reconnectTicket) {
            throw new Error('Realtime reconnect fixture entry is missing');
          }
          previous.expectedClose = true;
          previous.socket.close(1000, 'Reconnect probe');
          const connection = await openConnection(index, entry, entry.reconnectTicket);
          connections[index] = connection;
          allConnections.push(connection);
        }
      }),
    );
    reconnects = reconnectIndices.length;
    const reconnectDurationMs = Math.max(1, performance.now() - reconnectStarted);
    reconnectRatePerSecond = reconnects / (reconnectDurationMs / 1_000);
  }

  const activeConnections = connections.filter(
    (connection): connection is LiveConnection => connection !== undefined,
  );
  const slowResumeTimer = setTimeout(() => {
    for (const connection of activeConnections) connection.resumeSlowClient?.();
  }, slowClientResumeMs);
  process.stdout.write(
    `${JSON.stringify({
      status: 'ready_for_expected_event',
      certification: policy.certification,
      connections: activeConnections.length,
      reconnects,
      expectedEvent: fixture.expectedEvent,
      holdMs: policy.holdMs,
    })}\n`,
  );
  await new Promise((resolvePromise) => setTimeout(resolvePromise, policy.holdMs));
  clearTimeout(slowResumeTimer);
  for (const connection of activeConnections) connection.resumeSlowClient?.();

  const ready = activeConnections.map((connection) => connection.readyMs);
  const subscribed = activeConnections.map((connection) => connection.subscribedMs);
  const eventLatencies = activeConnections.flatMap((connection) => connection.eventLatencies);
  const deliveries = activeConnections.reduce(
    (sum, connection) => sum + connection.expectedEventDeliveries,
    0,
  );
  const unexpectedCloses = activeConnections.filter(
    (connection) => connection.closedUnexpectedly,
  ).length;
  const connectionP95Ms = percentile(subscribed, 0.95);
  const eventP95Ms = percentile(eventLatencies, 0.95);
  const eventP99Ms = percentile(eventLatencies, 0.99);
  const requiredEventLatencySamples = activeConnections.filter(
    (connection) => !connection.slowClient,
  ).length;
  const assertionFailures = [
    ...(policy.certification && connectionCount !== 20_000
      ? [`certification_connection_count_must_equal_20000:${connectionCount}`]
      : []),
    ...(eventLatencies.length < requiredEventLatencySamples
      ? [`event_latency_samples_missing:${requiredEventLatencySamples - eventLatencies.length}`]
      : []),
    ...(eventLatencies.some((latency) => latency < -1_000)
      ? ['event_latency_clock_skew_invalid']
      : []),
    ...evaluateRealtimeLoadAssertions({
      policy,
      observations: activeConnections.map((connection): RealtimeConnectionGateObservation => ({
        expectedEventDeliveries: connection.expectedEventDeliveries,
        unexpectedClose: connection.closedUnexpectedly,
        unauthorizedDeliveries: connection.unauthorizedDeliveries,
        deniedSubscriptionRequired: connection.deniedSubscriptionRequired,
        deniedSubscriptionVerified: connection.deniedSubscriptionVerified,
        slowClient: connection.slowClient,
        ...(connection.slowClientCloseCode === undefined
          ? {}
          : { slowClientCloseCode: connection.slowClientCloseCode }),
      })),
      reconnects,
      reconnectRatePerSecond,
    }),
  ];
  if (
    activeConnections.length !== connectionCount ||
    unexpectedCloses > 0 ||
    connectionP95Ms > connectionP95TargetMs ||
    assertionFailures.length > 0 ||
    (eventLatencies.length > 0 && (eventP95Ms > eventP95TargetMs || eventP99Ms > eventP99TargetMs))
  ) {
    throw new Error(
      `Communities realtime load gate failed: ${JSON.stringify({
        requestedConnections: connectionCount,
        establishedConnections: activeConnections.length,
        unexpectedCloses,
        deliveries,
        assertionFailures,
        reconnects,
        reconnectRatePerSecond: rounded(reconnectRatePerSecond),
        connectionP95Ms: rounded(connectionP95Ms),
        eventP95Ms: rounded(eventP95Ms),
        eventP99Ms: rounded(eventP99Ms),
      })}`,
    );
  }
  process.stdout.write(
    `${JSON.stringify({
      status: 'passed',
      certification: policy.certification,
      target: `${endpoint.protocol}//${endpoint.host}${endpoint.pathname}`,
      connections: connectionCount,
      rampConcurrency,
      rampDurationMs: rounded(rampDurationMs),
      holdMs: policy.holdMs,
      unexpectedCloses,
      deliveries,
      deliveryRequirement: 'AT_LEAST_ONE_EXACT_EXPECTED_EVENT_PER_NON_SLOW_CONNECTION',
      expectedEvent: fixture.expectedEvent,
      deniedSubscriptionProbes: activeConnections.filter(
        (connection) => connection.deniedSubscriptionRequired,
      ).length,
      slowClientProbes: activeConnections.filter((connection) => connection.slowClient).length,
      reconnects,
      reconnectRatePerSecond: rounded(reconnectRatePerSecond),
      connection: {
        readyP95Ms: rounded(percentile(ready, 0.95)),
        subscribedP95Ms: rounded(connectionP95Ms),
      },
      event: {
        samples: eventLatencies.length,
        p95Ms: rounded(eventP95Ms),
        p99Ms: rounded(eventP99Ms),
      },
    })}\n`,
  );
} finally {
  for (const connection of allConnections) {
    connection.resumeSlowClient?.();
    connection.expectedClose = true;
    connection.closedUnexpectedly = false;
    connection.socket.close(1000, 'Load complete');
  }
}
