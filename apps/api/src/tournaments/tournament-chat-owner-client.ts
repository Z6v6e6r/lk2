import { verifyTournamentReadGeneration } from '@phub/database';
import { createHash, createPrivateKey, randomUUID, sign, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { AppConfig } from '@phub/config';
import type { Pool } from 'pg';
import {
  TournamentChatError,
  parseTournamentChatReadPosition,
  parseTournamentChatReadReceipt,
  parseTournamentChatReadRequest,
  tournamentChatReadBody,
  type TournamentChatReadPosition,
  type TournamentChatReadReceipt,
  type TournamentChatReadRequest,
  parseTournamentChatCursor,
  parseTournamentChatPage,
  parseTournamentChatReceipt,
  parseTournamentChatRequest,
  tournamentChatSendBody,
  tournamentChatUuid,
  type TournamentChatPage,
  type TournamentChatReceipt,
  type TournamentChatRequest,
} from '@phub/domain';
import {
  createTournamentChatActorReader,
  type TournamentChatActor,
  type TournamentChatIdentity,
} from './tournament-chat-actor-context.js';
const PATH = '/internal/tournaments/chat/v1';
export interface TournamentChatOwner {
  position?(actor: TournamentChatActor, tournamentId: string): Promise<TournamentChatReadPosition>;
  advanceRead?(
    actor: TournamentChatActor,
    tournamentId: string,
    input: TournamentChatReadRequest,
  ): Promise<TournamentChatReadReceipt>;
  readStatus?(
    actor: TournamentChatActor,
    tournamentId: string,
    requestId: string,
  ): Promise<TournamentChatReadReceipt>;
  send(
    actor: TournamentChatActor,
    tournamentId: string,
    input: TournamentChatRequest,
  ): Promise<TournamentChatReceipt>;
  status(
    actor: TournamentChatActor,
    tournamentId: string,
    requestId: string,
  ): Promise<TournamentChatReceipt>;
  history(
    actor: TournamentChatActor,
    tournamentId: string,
    limit: number,
    cursor?: string,
  ): Promise<TournamentChatPage>;
}
interface Options {
  readonly baseUrl: string;
  readonly issuer: string;
  readonly kid: string;
  readonly privateKey: KeyObject;
  readonly tenantId: string;
  readonly tenantKey: string;
  readonly identity: (actor: TournamentChatActor) => Promise<TournamentChatIdentity>;
  readonly verifyGeneration?: (
    actor: TournamentChatActor,
    tournamentId: string,
    generation: string,
    identity: TournamentChatIdentity,
  ) => Promise<void>;
  readonly fetchImplementation?: typeof fetch;
  readonly now?: () => number;
}
export class TournamentChatOwnerClient implements TournamentChatOwner {
  private failures = 0;
  private openUntil = 0;
  private readonly transport: typeof fetch;
  private readonly now: () => number;
  private readonly origin: string;
  constructor(private readonly options: Options) {
    const url = new URL(options.baseUrl);
    if (
      url.protocol !== 'https:' ||
      url.pathname !== '/' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !tournamentChatUuid(options.tenantId) ||
      !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(options.tenantKey) ||
      !options.issuer ||
      options.issuer.length > 200 ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(options.kid) ||
      options.privateKey.asymmetricKeyType !== 'rsa' ||
      (options.privateKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
    )
      throw new TournamentChatError();
    this.origin = url.origin;
    this.transport = options.fetchImplementation ?? fetch;
    this.now = options.now ?? Date.now;
  }
  private scope(a: TournamentChatActor) {
    if (
      a.tenantId !== this.options.tenantId ||
      a.tenantKey !== this.options.tenantKey ||
      ![a.userId, a.sessionId, a.correlationId].every(tournamentChatUuid)
    )
      throw new TournamentChatError('TOURNAMENT_CHAT_FORBIDDEN', 403);
  }
  private async call<T>(
    a: TournamentChatActor,
    path: string,
    body: string,
    maxBytes: number,
    parse: (value: unknown) => T,
    key?: string,
  ): Promise<T> {
    this.scope(a);
    const before = await this.options.identity(a); // Local access failures cannot trip shared dependency breaker.
    if (this.openUntil > this.now()) throw new TournamentChatError();
    const now = Math.floor(this.now() / 1000),
      h = Buffer.from(
        JSON.stringify({
          alg: 'RS256',
          typ: 'phub-tournament-chat-actor+jwt',
          kid: this.options.kid,
        }),
      ).toString('base64url');
    const p = Buffer.from(
      JSON.stringify({
        contract_version: 1,
        iss: this.options.issuer,
        aud: 'cup-tournament-chat-v1',
        sub: a.userId,
        scope: 'tournaments.chat.actor',
        tenant_id: a.tenantId,
        tenant_key: a.tenantKey,
        owner_tenant_key: before.ownerTenantKey,
        provider_client_id: before.providerClientId,
        session_id: a.sessionId,
        method: 'POST',
        path,
        request_sha256: createHash('sha256').update(body).digest('hex'),
        correlation_id: a.correlationId,
        jti: randomUUID(),
        iat: now,
        nbf: now,
        exp: now + 30,
      }),
    ).toString('base64url');
    const token = `${h}.${p}.${sign('RSA-SHA256', Buffer.from(h + '.' + p), this.options.privateKey).toString('base64url')}`;
    let value: T;
    try {
      const response = await this.transport(this.origin + '/api' + path, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(8000),
        headers: {
          authorization: 'Bearer ' + token,
          'content-type': 'application/json',
          'x-correlation-id': a.correlationId,
          ...(key ? { 'idempotency-key': key } : {}),
        },
        body,
      });
      if ([400, 401, 403, 404].includes(response.status))
        throw new TournamentChatError('TOURNAMENT_CHAT_FORBIDDEN', 403);
      if (response.status === 409) throw new TournamentChatError('TOURNAMENT_CHAT_CONFLICT', 409);
      if (!response.ok || !response.body) throw new TournamentChatError();
      const reader = response.body.getReader(),
        chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const r = await reader.read();
          if (r.done) break;
          size += r.value.byteLength;
          if (size > maxBytes) throw new TournamentChatError();
          chunks.push(r.value);
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
      value = parse(
        JSON.parse(
          new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks)),
        ) as unknown,
      );
      this.failures = 0;
    } catch (error) {
      if (!(error instanceof TournamentChatError) || error.status === 503) {
        if (++this.failures >= 3) this.openUntil = this.now() + 10000;
      }
      throw error instanceof TournamentChatError ? error : new TournamentChatError();
    }
    // Fresh local session/mapping denial is never an owner dependency failure.
    const after = await this.options.identity(a);
    if (
      after.ownerTenantKey !== before.ownerTenantKey ||
      after.providerClientId !== before.providerClientId
    )
      throw new TournamentChatError('TOURNAMENT_CHAT_FORBIDDEN', 403);
    return value;
  }
  private async readProof(a: TournamentChatActor, tournamentId: string, raw: unknown) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TournamentChatError();
    const value = raw as Record<string, unknown>,
      w = value.witness;
    if (!w || typeof w !== 'object' || Array.isArray(w)) throw new TournamentChatError();
    const witness = w as Record<string, unknown>;
    const identity = await this.options.identity(a);
    if (witness.kind === 'PARTICIPANT') {
      if (
        Object.keys(witness).sort().join(',') !== 'actorHash,generation,kind' ||
        !tournamentChatUuid(witness.generation) ||
        witness.actorHash !==
          createHash('sha256')
            .update(
              'tournament-local-actor:v1\0' +
                JSON.stringify([identity.ownerTenantKey, identity.providerClientId]),
            )
            .digest('hex') ||
        !this.options.verifyGeneration
      )
        throw new TournamentChatError('TOURNAMENT_CHAT_FORBIDDEN', 403);
      try {
        await this.options.verifyGeneration(a, tournamentId, witness.generation, identity);
      } catch {
        throw new TournamentChatError('TOURNAMENT_CHAT_FORBIDDEN', 403);
      }
    } else if (
      witness.kind !== 'ORGANIZER' ||
      Object.keys(witness).sort().join(',') !== 'kind,revision,selectedUserId' ||
      witness.selectedUserId !== a.userId ||
      !Number.isSafeInteger(witness.revision) ||
      Number(witness.revision) < 1
    )
      throw new TournamentChatError('TOURNAMENT_CHAT_FORBIDDEN', 403);
    if (
      value.witnessHash !==
      createHash('sha256')
        .update('tournament-chat-witness:v1\0' + JSON.stringify(witness))
        .digest('hex')
    )
      throw new TournamentChatError();
    const after = await this.options.identity(a);
    if (
      after.ownerTenantKey !== identity.ownerTenantKey ||
      after.providerClientId !== identity.providerClientId
    )
      throw new TournamentChatError('TOURNAMENT_CHAT_FORBIDDEN', 403);
    const publicValue = { ...value };
    delete publicValue.witness;
    return publicValue;
  }
  async position(
    a: TournamentChatActor,
    tournamentId: string,
  ): Promise<TournamentChatReadPosition> {
    if (!tournamentChatUuid(tournamentId))
      throw new TournamentChatError('TOURNAMENT_CHAT_INPUT_INVALID', 400);
    const raw = await this.call(
      a,
      PATH + '/read-position',
      JSON.stringify({ contractVersion: 1, tournamentId }),
      8192,
      (v) => v,
    );
    return parseTournamentChatReadPosition(
      await this.readProof(a, tournamentId, raw),
      tournamentId,
    );
  }
  async advanceRead(
    a: TournamentChatActor,
    tournamentId: string,
    input: TournamentChatReadRequest,
  ): Promise<TournamentChatReadReceipt> {
    const x = parseTournamentChatReadRequest(input);
    // Fresh owner witness + immutable original JOIN tuple is required BEFORE any READ mutation.
    const current = await this.position(a, tournamentId);
    if (current.streamId !== x.streamId || current.witnessHash !== x.witnessHash)
      throw new TournamentChatError('TOURNAMENT_CHAT_CONFLICT', 409);
    const body = tournamentChatReadBody(tournamentId, x);
    const expected = createHash('sha256')
      .update('tournament-chat-read-request:v1\0' + body)
      .digest('hex');
    const raw = await this.call(a, PATH + '/read-requests', body, 8192, (v) => v, x.requestId);
    const publicValue =
      raw && typeof raw === 'object' && 'status' in raw && raw.status === 'CONFIRMED'
        ? await this.readProof(a, tournamentId, raw)
        : raw;
    return parseTournamentChatReadReceipt(publicValue, tournamentId, x.requestId, expected);
  }
  async readStatus(
    a: TournamentChatActor,
    tournamentId: string,
    requestId: string,
  ): Promise<TournamentChatReadReceipt> {
    if (![tournamentId, requestId].every(tournamentChatUuid))
      throw new TournamentChatError('TOURNAMENT_CHAT_INPUT_INVALID', 400);
    const raw = await this.call(
      a,
      PATH + '/read-requests/read',
      JSON.stringify({ contractVersion: 1, tournamentId, requestId }),
      8192,
      (v) => v,
    );
    const publicValue =
      raw && typeof raw === 'object' && 'status' in raw && raw.status === 'CONFIRMED'
        ? await this.readProof(a, tournamentId, raw)
        : raw;
    return parseTournamentChatReadReceipt(publicValue, tournamentId, requestId);
  }

  send(a: TournamentChatActor, tournamentId: string, raw: TournamentChatRequest) {
    if (!tournamentChatUuid(tournamentId))
      throw new TournamentChatError('TOURNAMENT_CHAT_INPUT_INVALID', 400);
    const x = parseTournamentChatRequest(raw),
      body = tournamentChatSendBody(tournamentId, x);
    const expectedHash = createHash('sha256')
      .update('tournament-chat-request:v1\0' + body)
      .digest('hex');
    return this.call(
      a,
      PATH + '/message-requests',
      body,
      8192,
      (v) => parseTournamentChatReceipt(v, tournamentId, x.requestId, expectedHash),
      x.requestId,
    );
  }
  status(a: TournamentChatActor, tournamentId: string, requestId: string) {
    if (![tournamentId, requestId].every(tournamentChatUuid))
      throw new TournamentChatError('TOURNAMENT_CHAT_INPUT_INVALID', 400);
    return this.call(
      a,
      PATH + '/message-requests/read',
      JSON.stringify({ contractVersion: 1, tournamentId, requestId }),
      8192,
      (v) => parseTournamentChatReceipt(v, tournamentId, requestId),
    );
  }
  history(a: TournamentChatActor, tournamentId: string, limit: number, cursor?: string) {
    if (!tournamentChatUuid(tournamentId) || !Number.isInteger(limit) || limit < 1 || limit > 50)
      throw new TournamentChatError('TOURNAMENT_CHAT_INPUT_INVALID', 400);
    if (cursor) {
      const c = parseTournamentChatCursor(cursor);
      if (
        c.tenantId !== a.tenantId ||
        c.actorUserId !== a.userId ||
        c.tournamentId !== tournamentId
      )
        throw new TournamentChatError('TOURNAMENT_CHAT_CONFLICT', 409);
    }
    return this.call(
      a,
      PATH + '/history',
      JSON.stringify({ contractVersion: 1, tournamentId, limit, ...(cursor ? { cursor } : {}) }),
      3 * 1024 * 1024,
      (v) => {
        const page = parseTournamentChatPage(v, tournamentId, limit, cursor);
        if (page.nextCursor) {
          const c = parseTournamentChatCursor(page.nextCursor);
          if (c.tenantId !== a.tenantId || c.actorUserId !== a.userId)
            throw new TournamentChatError();
        }
        return page;
      },
    );
  }
}
export function createTournamentChatOwner(
  config: AppConfig,
  pool: Pool,
): TournamentChatOwner | undefined {
  if (!config.TOURNAMENT_CHAT_ENABLED) return undefined;
  const file = config.TOURNAMENT_CHAT_ACTOR_PRIVATE_KEY_FILE;
  if (!file) throw new Error('TOURNAMENT_CHAT_CONFIG_INVALID');
  const bytes = readFileSync(file);
  if (bytes.length > 16384) throw new Error('TOURNAMENT_CHAT_CONFIG_INVALID');
  return new TournamentChatOwnerClient({
    baseUrl: config.TOURNAMENT_CHAT_OWNER_BASE_URL!,
    tenantId: config.TOURNAMENT_CHAT_TENANT_ID!,
    tenantKey: config.TOURNAMENT_CHAT_TENANT_KEY!,
    issuer: config.TOURNAMENT_CHAT_ACTOR_ISSUER!,
    kid: config.TOURNAMENT_CHAT_ACTOR_KEY_ID!,
    privateKey: createPrivateKey(bytes),
    identity: createTournamentChatActorReader(pool),
    verifyGeneration: (actor, tournamentId, generation, identity) =>
      verifyTournamentReadGeneration(
        pool,
        { tenantId: actor.tenantId, userId: actor.userId, tournamentId },
        generation,
        identity,
      ),
  });
}
