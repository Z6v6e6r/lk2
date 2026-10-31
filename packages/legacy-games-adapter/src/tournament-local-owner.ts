import {
  TournamentLocalError,
  tournamentObject,
  tournamentDate,
  parseTournamentReceipt,
  type TournamentOwnerCommand,
  type TournamentOwnerReceipt,
} from '@phub/domain';
type Phase = 'identity' | 'prepare' | 'command' | 'read';
type Metric = {
  phase: Phase;
  outcome: 'success' | 'refused' | 'unavailable' | 'circuit_open';
  durationMs: number;
};
export class TournamentLocalOwnerClient {
  private readonly origin: string;
  private readonly circuits = new Map<
    Phase,
    { failures: number; until: number; probing: boolean }
  >();
  constructor(
    private readonly options: {
      identityUrl: string;
      integrationToken: string;
      timeoutMs?: number;
      fetchImplementation?: typeof fetch;
      now?: () => number;
      onMetric?: (metric: Metric) => void;
    },
  ) {
    const u = new URL(options.identityUrl);
    if (
      u.pathname !== '/api/internal/lk/identity/verify' ||
      u.protocol !== 'https:' ||
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      !options.integrationToken ||
      /[\r\n]/.test(options.integrationToken)
    )
      throw new TournamentLocalError();
    this.origin = u.origin;
  }
  private metric(metric: Metric) {
    try {
      this.options.onMetric?.(metric);
    } catch {
      /* Observation cannot change an owner ACK. */
    }
  }
  private async boundary<T>(phase: Phase, call: () => Promise<T>): Promise<T> {
    const now = () => this.options.now?.() ?? Date.now(),
      start = now(),
      state = this.circuits.get(phase) ?? { failures: 0, until: 0, probing: false };
    this.circuits.set(phase, state);
    if (state.until > start || state.probing) {
      this.metric({ phase, outcome: 'circuit_open', durationMs: 0 });
      throw new TournamentLocalError('TOURNAMENT_LOCAL_OWNER_CIRCUIT_OPEN');
    }
    if (state.until) state.probing = true;
    try {
      const result = await call();
      state.failures = 0;
      state.until = 0;
      this.metric({ phase, outcome: 'success', durationMs: Math.max(0, now() - start) });
      return result;
    } catch (error) {
      const refused = error instanceof TournamentLocalError && error.status < 500;
      if (!refused) {
        state.failures++;
        if (state.failures >= 3) state.until = now() + 30000;
      } else {
        state.failures = 0;
        state.until = 0;
      }
      this.metric({
        phase,
        outcome: refused ? 'refused' : 'unavailable',
        durationMs: Math.max(0, now() - start),
      });
      throw error;
    } finally {
      state.probing = false;
    }
  }
  private async post(
    path: string,
    token: string,
    body?: unknown,
    key?: string,
    correlationId: string = globalThis.crypto.randomUUID(),
  ): Promise<unknown> {
    if (!token || /[\r\n]/.test(token))
      throw new TournamentLocalError('TOURNAMENT_LOCAL_IDENTITY_UNAVAILABLE', 403);
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(correlationId) || /[\r\n]/.test(correlationId))
      throw new TournamentLocalError('TOURNAMENT_LOCAL_CORRELATION_INVALID', 400);
    const url = new URL(path, this.origin).href;
    const r = await (this.options.fetchImplementation ?? fetch)(url, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 5000),
      headers: {
        Authorization: `Bearer ${token}`,
        'X-CUP-Integration-Token': this.options.integrationToken,
        'X-Correlation-ID': correlationId,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(key ? { 'Idempotency-Key': key } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (r.redirected || (r.url && r.url !== url) || !r.body) throw new TournamentLocalError();
    const reader = r.body.getReader(),
      chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const n = await reader.read();
        if (n.done) break;
        size += n.value.length;
        if (size > 16384) {
          await reader.cancel();
          throw new TournamentLocalError();
        }
        chunks.push(n.value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const c of chunks) {
      bytes.set(c, offset);
      offset += c.length;
    }
    if (!r.ok)
      throw new TournamentLocalError(
        r.status === 404
          ? 'TOURNAMENT_LOCAL_OWNER_NOT_FOUND'
          : r.status === 409
            ? 'TOURNAMENT_LOCAL_OWNER_CONFLICT'
            : r.status === 401 || r.status === 403
              ? 'TOURNAMENT_LOCAL_IDENTITY_UNAVAILABLE'
              : 'TOURNAMENT_LOCAL_UNAVAILABLE',
        r.status === 404
          ? 404
          : r.status === 409
            ? 409
            : r.status === 401 || r.status === 403
              ? 403
              : r.status >= 400 && r.status < 500
                ? r.status
                : 503,
      );
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  }
  identity(
    token: string,
    correlationId?: string,
  ): Promise<{ tenantKey: string; clientId: string }> {
    return this.boundary('identity', async () => {
      const r = await this.post(
        new URL(this.options.identityUrl).pathname,
        token,
        undefined,
        undefined,
        correlationId,
      );
      const x = r as {
        ok?: unknown;
        actor?: { verified?: unknown; source?: unknown; tenantKey?: unknown; clientId?: unknown };
      };
      if (
        x?.ok !== true ||
        x.actor?.verified !== true ||
        x.actor.source !== 'cup-keycloak-jwt' ||
        typeof x.actor.tenantKey !== 'string' ||
        typeof x.actor.clientId !== 'string' ||
        !x.actor.clientId ||
        x.actor.clientId.length > 200 ||
        x.actor.clientId.trim() !== x.actor.clientId ||
        /[\r\n]/.test(x.actor.clientId)
      )
        throw new TournamentLocalError();
      return { tenantKey: x.actor.tenantKey, clientId: x.actor.clientId };
    });
  }
  prepare(
    token: string,
    tournamentId: string,
    date: string,
    correlationId?: string,
  ): Promise<void> {
    return this.boundary('prepare', async () => {
      if (!tournamentDate(date))
        throw new TournamentLocalError('TOURNAMENT_LOCAL_INPUT_INVALID', 400);
      const x = await this.post(
        '/api/internal/tournaments/owner-preparations',
        token,
        { tournamentId, date },
        undefined,
        correlationId,
      );
      const time = (v: unknown) =>
        typeof v === 'string' &&
        Number.isFinite(Date.parse(v)) &&
        Date.parse(v) <= Date.now() + 5000;
      if (
        !tournamentObject(
          x,
          'schemaVersion,nonBinding,tournamentId,date,observedAt,status,owner,binding,reason',
        ) ||
        x.schemaVersion !== 1 ||
        x.nonBinding !== true ||
        x.tournamentId !== tournamentId ||
        x.date !== date ||
        !time(x.observedAt) ||
        Date.now() - Date.parse(x.observedAt as string) > 60000
      )
        throw new TournamentLocalError();
      if (x.status === 'UNKNOWN')
        throw new TournamentLocalError('TOURNAMENT_LOCAL_MAPPING_UNAVAILABLE');
      if (
        x.status !== 'RESOLVED' ||
        x.reason !== null ||
        !['CUP_CUSTOM', 'VIVA_SOURCE'].includes(x.owner as string) ||
        !tournamentObject(
          x.binding,
          'feedId,exerciseId,customTournamentId,customUpdatedAt,sourceUpdatedAt,snapshotGeneratedAt,snapshotLastSuccessfulAt,mappingSha256',
        )
      )
        throw new TournamentLocalError();
      if (x.owner !== 'CUP_CUSTOM' || x.binding.exerciseId !== null)
        throw new TournamentLocalError('TOURNAMENT_LOCAL_UNSUPPORTED', 409);
      const b = x.binding;
      if (
        typeof b.customTournamentId !== 'string' ||
        !b.customTournamentId ||
        b.feedId !== b.customTournamentId ||
        b.sourceUpdatedAt !== null ||
        !time(b.customUpdatedAt) ||
        !time(b.snapshotGeneratedAt) ||
        !time(b.snapshotLastSuccessfulAt) ||
        typeof b.mappingSha256 !== 'string' ||
        !/^sha256:[a-f0-9]{64}$/.test(b.mappingSha256)
      )
        throw new TournamentLocalError();
      const { createHash } = await import('node:crypto');
      const bytes = createHash('sha256')
        .update('phub-public-tournament-v1:' + b.customTournamentId)
        .digest()
        .subarray(0, 16);
      bytes[6] = (bytes[6]! & 15) | 64;
      bytes[8] = (bytes[8]! & 63) | 128;
      const h = bytes.toString('hex');
      if (
        `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}` !==
        tournamentId
      )
        throw new TournamentLocalError();
    });
  }
  command(
    token: string,
    key: string,
    command: TournamentOwnerCommand,
    id: string,
    correlationId?: string,
  ): Promise<TournamentOwnerReceipt> {
    return this.boundary('command', async () =>
      parseTournamentReceipt(
        await this.post(
          '/api/internal/tournaments/local-operations',
          token,
          command,
          key,
          correlationId,
        ),
        command,
        id,
      ),
    );
  }
  read(
    token: string,
    command: TournamentOwnerCommand,
    id: string,
    correlationId?: string,
  ): Promise<TournamentOwnerReceipt> {
    return this.boundary('read', async () =>
      parseTournamentReceipt(
        await this.post(
          '/api/internal/tournaments/local-operations/read',
          token,
          { schemaVersion: 1, tournamentId: command.tournamentId, operationId: id },
          undefined,
          correlationId,
        ),
        command,
        id,
      ),
    );
  }
}
