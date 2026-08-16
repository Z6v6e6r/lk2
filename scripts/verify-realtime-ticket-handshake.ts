import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import WebSocket, { type RawData } from 'ws';

const MAX_TIMEOUT_MS = 15_000;

type FetchLike = typeof fetch;
type SocketLike = Pick<WebSocket, 'close' | 'on' | 'once' | 'send' | 'terminate'> & {
  readonly readyState: number;
};

function rawDataText(raw: RawData): string {
  if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8');
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf8');
  return raw.toString('utf8');
}

export async function verifyRealtimeTicketHandshake(options: {
  readonly baseUrl: string;
  readonly tenantKey: string;
  readonly accessToken: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: FetchLike;
  readonly socketFactory?: (url: URL) => SocketLike;
}): Promise<void> {
  const baseUrl = new URL(options.baseUrl);
  if (baseUrl.protocol !== 'https:' && baseUrl.protocol !== 'http:') {
    throw new Error('REALTIME_HANDSHAKE_BASE_URL_INVALID');
  }
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(options.tenantKey)) {
    throw new Error('REALTIME_HANDSHAKE_TENANT_KEY_INVALID');
  }
  if (!options.accessToken || options.accessToken.length > 8_192) {
    throw new Error('REALTIME_HANDSHAKE_ACCESS_TOKEN_INVALID');
  }
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error('REALTIME_HANDSHAKE_TIMEOUT_INVALID');
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const ticketUrl = new URL(
    `/user/api/v1/${encodeURIComponent(options.tenantKey)}/messaging/realtime-ticket`,
    baseUrl,
  );
  const response = await fetchImpl(ticketUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${options.accessToken}`,
      'X-Correlation-ID': randomUUID(),
      'X-App-Platform': 'web',
      'X-App-Version': 'b0-runtime-secret-bootstrap',
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.status !== 200) throw new Error(`REALTIME_HANDSHAKE_TICKET_HTTP_${response.status}`);
  const body = (await response.json().catch(() => undefined)) as
    { readonly ticket?: unknown; readonly expiresAt?: unknown } | undefined;
  if (
    typeof body?.ticket !== 'string' ||
    body.ticket.length < 32 ||
    body.ticket.length > 4_096 ||
    typeof body.expiresAt !== 'string'
  ) {
    throw new Error('REALTIME_HANDSHAKE_TICKET_INVALID');
  }

  const realtimeUrl = new URL(`/realtime/v1/${encodeURIComponent(options.tenantKey)}`, baseUrl);
  realtimeUrl.protocol = realtimeUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = (options.socketFactory ?? ((url) => new WebSocket(url, { maxPayload: 16_384 })))(
    realtimeUrl,
  );
  let settled = false;
  const completion = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.terminate();
      reject(new Error('REALTIME_HANDSHAKE_CONNECTION_TIMEOUT'));
    }, timeoutMs);
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        socket.terminate();
        reject(error);
      } else resolve();
    };
    socket.once('open', () => {
      socket.send(JSON.stringify({ type: 'authenticate', ticket: body.ticket }));
    });
    socket.on('message', (raw: RawData) => {
      let message: unknown;
      try {
        message = JSON.parse(rawDataText(raw)) as unknown;
      } catch {
        finish(new Error('REALTIME_HANDSHAKE_MESSAGE_INVALID'));
        return;
      }
      if (
        typeof message === 'object' &&
        message !== null &&
        'type' in message &&
        message.type === 'connection.ready'
      ) {
        finish();
        socket.close(1000, 'Bootstrap verification complete');
      }
    });
    socket.once('error', () => finish(new Error('REALTIME_HANDSHAKE_SOCKET_ERROR')));
    socket.once('close', (code: number) => {
      if (!settled) finish(new Error(`REALTIME_HANDSHAKE_SOCKET_CLOSED_${code}`));
    });
  });
  await completion;
}

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv
    .slice(2)
    .find((value) => value.startsWith(prefix))
    ?.slice(prefix.length);
}

if (resolve(process.argv[1] ?? '') === resolve(fileURLToPath(import.meta.url))) {
  try {
    await verifyRealtimeTicketHandshake({
      baseUrl: argument('base-url') ?? '',
      tenantKey: argument('tenant-key') ?? '',
      accessToken: process.env.STAGING_REALTIME_SMOKE_ACCESS_TOKEN ?? '',
    });
    process.stdout.write(
      'realtime_ticket_handshake authenticated=true mutation=ephemeral-ticket-only status=passed\n',
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
