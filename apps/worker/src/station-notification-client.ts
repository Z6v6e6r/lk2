import { performance } from 'node:perf_hooks';
import {
  STATION_CONTRACT,
  parseStationResponse,
  stationCanonical,
  stationRequests,
  type StationMode,
  type StationRequest,
  type StationResponses,
} from './station-notification-protocol.js';

export class StationNotificationClient {
  private failures = 0;
  private openUntil = 0;
  constructor(
    private readonly options: {
      origin: string;
      sign: (mode: StationMode, body: StationRequest, correlation: string) => string;
      fetch?: typeof fetch;
      now?: () => number;
      monotonic?: () => number;
      observe?: (phase: StationMode, outcome: 'OK' | 'UNAVAILABLE', durationMs: number) => void;
    },
  ) {
    const u = new URL(options.origin);
    if (
      u.protocol !== 'https:' ||
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      u.pathname !== '/'
    )
      throw Error('STATION_ORIGIN_INVALID');
  }
  async read<M extends StationMode>(
    mode: M,
    body: StationRequest,
  ): Promise<{ value: StationResponses[M]; fresh: () => boolean }> {
    const now = () => this.options.now?.() ?? Date.now(),
      mono = () => this.options.monotonic?.() ?? performance.now(),
      start = mono();
    if (this.openUntil > now()) throw Error('STATION_OWNER_UNAVAILABLE');
    const controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), 10_000);
    try {
      stationRequests[mode].parse(body);
      const text = stationCanonical(body);
      if (Buffer.byteLength(text) > 8192) throw Error('STATION_REQUEST_TOO_LARGE');
      const url = new URL('/lk/internal/station-notifications/v1/' + mode, this.options.origin)
        .href;
      const r = await (this.options.fetch ?? fetch)(url, {
        method: 'POST',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          'x-correlation-id': body.requestId,
          'x-padlhub-station-notification-contract': STATION_CONTRACT,
          'x-station-notification-delegation': this.options.sign(mode, body, body.requestId),
        },
        body: text,
      });
      if (r.status !== 200 || r.url !== url || Number(r.headers.get('content-length')) > 65536)
        throw Error('STATION_RESPONSE_INVALID');
      const reader = r.body?.getReader();
      if (!reader) throw Error('STATION_RESPONSE_INVALID');
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        for (;;) {
          const p = await reader.read();
          if (p.done) break;
          length += p.value.length;
          if (length > 65536) throw Error('STATION_RESPONSE_INVALID');
          chunks.push(p.value);
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
      const value = parseStationResponse(
        mode,
        JSON.parse(Buffer.concat(chunks).toString('utf8')),
        body,
        now(),
      );
      const received = mono(),
        remaining = Math.min(value.validUntilMs - now(), 5000);
      const fresh = () =>
        !controller.signal.aborted &&
        mono() - start < 10_000 &&
        mono() - received < remaining &&
        now() < value.validUntilMs;
      if (!fresh()) throw Error('STATION_AUTHORIZATION_EXPIRED');
      this.failures = 0;
      this.openUntil = 0;
      this.observe(mode, 'OK', mono() - start);
      return { value, fresh };
    } catch {
      if (++this.failures >= 3) this.openUntil = now() + 30_000;
      this.observe(mode, 'UNAVAILABLE', mono() - start);
      throw Error('STATION_OWNER_UNAVAILABLE');
    } finally {
      clearTimeout(timer);
    }
  }
  private observe(phase: StationMode, outcome: 'OK' | 'UNAVAILABLE', durationMs: number) {
    try {
      this.options.observe?.(phase, outcome, durationMs);
    } catch {
      /* Telemetry cannot affect authorization. */
    }
  }
}
