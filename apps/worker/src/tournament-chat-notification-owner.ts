import { createHash, createPrivateKey, randomUUID, sign, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type {
  TournamentNotificationWitness,
  TournamentNotificationIdentity,
} from '@phub/database/tournament-notifications';
export const TOURNAMENT_FEED_VERSION = 'tournament-chat-notifications.v1';
const PATH = '/internal/tournaments/chat-notifications/v1';
const uuid = (x: unknown): x is string =>
  typeof x === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(x);
const hash = (x: unknown): x is string => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const safe = (x: unknown): x is number => Number.isSafeInteger(x) && Number(x) >= 0;
const digest = (domain: string, value: unknown) =>
  createHash('sha256')
    .update(domain + '\0' + JSON.stringify(value))
    .digest('hex');
export class TournamentNotificationFeedError extends Error {
  constructor(
    readonly code = 'TOURNAMENT_NOTIFICATION_UNAVAILABLE',
    readonly dependency = true,
  ) {
    super(code);
  }
}
const fail = () => new TournamentNotificationFeedError();
function obj(value: unknown, names: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== names
  )
    throw fail();
  return value as Record<string, unknown>;
}
export interface TournamentFeedBinding {
  tournamentId: string;
  incarnationHash: string;
  streamId: string;
}
export interface TournamentFeedFact extends TournamentFeedBinding {
  sequence: number;
  messageId: string;
  authorUserId: string;
  factHash: string;
}
export interface TournamentFeedRecipient {
  witness: TournamentNotificationWitness;
  witnessHash: string;
  baselineSequence: number;
  capturedReadThroughSequence: number;
}
export interface TournamentFeedPublicationInput extends TournamentFeedBinding {
  afterSequence: number;
  throughSequence: number | null;
  limit: number;
}
export interface TournamentFeedPublicationPage extends TournamentFeedBinding {
  contractVersion: typeof TOURNAMENT_FEED_VERSION;
  throughSequence: number;
  facts: TournamentFeedFact[];
  nextAfterSequence: number | null;
  hasMore: boolean;
}
export interface TournamentFeedRecipientPage {
  contractVersion: typeof TOURNAMENT_FEED_VERSION;
  fact: TournamentFeedFact;
  throughSequence: number;
  snapshotHash: string;
  candidates: TournamentFeedRecipient[];
  nextCursor: string | null;
  hasMore: boolean;
}
export interface TournamentFeedEligibility {
  contractVersion: typeof TOURNAMENT_FEED_VERSION;
  fact: TournamentFeedFact;
  userId: string;
  witnessHash: string;
  baselineSequence: number;
  decision: 'ALLOW' | 'DENY';
  code: 'ELIGIBLE' | 'CURRENT_CONTEXT_CHANGED' | 'AUTHOR' | 'READ' | 'BASELINE';
  observedAt: number;
  validUntil: number;
}
function binding(x: Record<string, unknown>): TournamentFeedBinding {
  if (!uuid(x.tournamentId) || !uuid(x.streamId) || !hash(x.incarnationHash)) throw fail();
  return { tournamentId: x.tournamentId, incarnationHash: x.incarnationHash, streamId: x.streamId };
}
function fact(value: unknown): TournamentFeedFact {
  const x = obj(
    value,
    'authorUserId,factHash,incarnationHash,messageId,sequence,streamId,tournamentId',
  );
  if (
    !safe(x.sequence) ||
    x.sequence < 1 ||
    !uuid(x.messageId) ||
    !uuid(x.authorUserId) ||
    !hash(x.factHash)
  )
    throw fail();
  return {
    ...binding(x),
    sequence: x.sequence,
    messageId: x.messageId,
    authorUserId: x.authorUserId,
    factHash: x.factHash,
  };
}
function recipient(value: unknown): TournamentFeedRecipient {
  const x = obj(value, 'baselineSequence,capturedReadThroughSequence,witness,witnessHash');
  let w: TournamentNotificationWitness;
  if (
    x.witness &&
    typeof x.witness === 'object' &&
    'kind' in x.witness &&
    x.witness.kind === 'PARTICIPANT'
  ) {
    const y = obj(x.witness, 'actorHash,generation,kind');
    if (!uuid(y.generation) || !hash(y.actorHash)) throw fail();
    w = { kind: 'PARTICIPANT', generation: y.generation, actorHash: y.actorHash };
  } else {
    const y = obj(x.witness, 'kind,revision,selectedUserId');
    if (y.kind !== 'ORGANIZER' || !safe(y.revision) || y.revision < 1 || !uuid(y.selectedUserId))
      throw fail();
    w = { kind: 'ORGANIZER', revision: y.revision, selectedUserId: y.selectedUserId };
  }
  if (
    x.witnessHash !== digest('tournament-chat-witness:v1', w) ||
    !safe(x.baselineSequence) ||
    !safe(x.capturedReadThroughSequence) ||
    x.baselineSequence > x.capturedReadThroughSequence
  )
    throw fail();
  return {
    witness: w,
    witnessHash: x.witnessHash,
    baselineSequence: x.baselineSequence,
    capturedReadThroughSequence: x.capturedReadThroughSequence,
  };
}
const sameFact = (a: unknown, b: TournamentFeedFact) => {
  const parsed = fact(a);
  if (JSON.stringify(parsed) !== JSON.stringify(b)) throw fail();
  return parsed;
};
function cursor(value: unknown) {
  if (typeof value !== 'string' || value.length > 1800 || !/^[A-Za-z0-9_-]+$/.test(value))
    throw fail();
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value) throw fail();
  const c = obj(
    JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)) as unknown,
    'afterWitnessHash,factHash,snapshotHash,throughSequence,version',
  );
  if (
    c.version !== 1 ||
    !hash(c.factHash) ||
    !hash(c.snapshotHash) ||
    !hash(c.afterWitnessHash) ||
    !safe(c.throughSequence)
  )
    throw fail();
  return {
    factHash: c.factHash,
    snapshotHash: c.snapshotHash,
    afterWitnessHash: c.afterWitnessHash,
    throughSequence: c.throughSequence,
  };
}
export interface TournamentFeedOptions {
  baseUrl: string;
  tenantId: string;
  tenantKey: string;
  ownerTenantKey: string;
  issuer: string;
  kid: string;
  privateKey: KeyObject;
  resolve: (
    tournamentId: string,
    witness: TournamentNotificationWitness,
  ) => Promise<TournamentNotificationIdentity>;
  fetchImplementation?: typeof fetch;
  now?: () => number;
}
export class TournamentNotificationOwnerClient {
  readonly metrics = { calls: 0, unavailable: 0, denied: 0 };
  private failures = 0;
  private openUntil = 0;
  private readonly transport: typeof fetch;
  private readonly now: () => number;
  private readonly origin: string;
  constructor(private readonly options: TournamentFeedOptions) {
    const u = new URL(options.baseUrl);
    if (
      u.protocol !== 'https:' ||
      u.pathname !== '/' ||
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      !uuid(options.tenantId) ||
      !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(options.tenantKey) ||
      !/^[A-Za-z0-9_-]{1,200}$/.test(options.ownerTenantKey) ||
      !options.issuer ||
      options.issuer.length > 200 ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(options.kid) ||
      options.privateKey.asymmetricKeyType !== 'rsa' ||
      (options.privateKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
    )
      throw fail();
    this.origin = u.origin;
    this.transport = options.fetchImplementation ?? fetch;
    this.now = options.now ?? Date.now;
  }
  private async call<T>(
    op: 'publications' | 'recipients' | 'eligibility',
    body: unknown,
    parse: (raw: unknown) => T,
  ): Promise<T> {
    if (this.openUntil > this.now()) throw fail();
    const raw = JSON.stringify(body);
    if (Buffer.byteLength(raw) > 16000) throw fail();
    const correlation = randomUUID(),
      seconds = Math.floor(this.now() / 1000),
      h = Buffer.from(
        JSON.stringify({
          alg: 'RS256',
          typ: 'phub-tournament-chat-notifications+jwt',
          kid: this.options.kid,
        }),
      ).toString('base64url');
    const p = Buffer.from(
      JSON.stringify({
        contract_version: 1,
        iss: this.options.issuer,
        aud: 'cup-tournament-chat-notifications-v1',
        sub: 'lk2-tournament-notification-bridge',
        scope: 'tournaments.chat.notifications.' + op,
        tenant_id: this.options.tenantId,
        tenant_key: this.options.tenantKey,
        owner_tenant_key: this.options.ownerTenantKey,
        method: 'POST',
        path: PATH + '/' + op,
        request_sha256: createHash('sha256').update(raw).digest('hex'),
        correlation_id: correlation,
        jti: randomUUID(),
        iat: seconds,
        nbf: seconds,
        exp: seconds + 30,
      }),
    ).toString('base64url');
    const token =
      h +
      '.' +
      p +
      '.' +
      sign('RSA-SHA256', Buffer.from(h + '.' + p), this.options.privateKey).toString('base64url');
    this.metrics.calls++;
    try {
      const response = await this.transport(this.origin + '/api' + PATH + '/' + op, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(2000),
        headers: {
          authorization: 'Bearer ' + token,
          'content-type': 'application/json',
          'x-correlation-id': correlation,
        },
        body: raw,
      });
      if ([400, 401, 403, 404, 409].includes(response.status)) {
        this.metrics.denied++;
        throw new TournamentNotificationFeedError('TOURNAMENT_NOTIFICATION_REFUSED', false);
      }
      if (!response.ok || !response.body) throw fail();
      const reader = response.body.getReader(),
        chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const r = await reader.read();
          if (r.done) break;
          size += r.value.byteLength;
          if (size > 256000) throw fail();
          chunks.push(r.value);
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
      const result = parse(
        JSON.parse(
          new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks)),
        ) as unknown,
      );
      this.failures = 0;
      return result;
    } catch (e) {
      if (!(e instanceof TournamentNotificationFeedError) || e.dependency) {
        this.metrics.unavailable++;
        if (++this.failures >= 3) this.openUntil = this.now() + 15000;
      }
      throw e instanceof TournamentNotificationFeedError ? e : fail();
    }
  }
  publications(input: TournamentFeedPublicationInput): Promise<TournamentFeedPublicationPage> {
    const b = binding(input as unknown as Record<string, unknown>);
    if (
      !safe(input.afterSequence) ||
      !safe(input.limit) ||
      input.limit < 1 ||
      input.limit > 50 ||
      (input.throughSequence !== null &&
        (!safe(input.throughSequence) || input.throughSequence < input.afterSequence))
    )
      throw fail();
    return this.call(
      'publications',
      {
        version: 1,
        ...b,
        afterSequence: input.afterSequence,
        throughSequence: input.throughSequence,
        limit: input.limit,
      },
      (raw) => {
        const x = obj(
          raw,
          'contractVersion,facts,hasMore,incarnationHash,nextAfterSequence,streamId,throughSequence,tournamentId',
        );
        if (
          x.contractVersion !== TOURNAMENT_FEED_VERSION ||
          JSON.stringify(binding(x)) !== JSON.stringify(b) ||
          !safe(x.throughSequence) ||
          x.throughSequence < input.afterSequence ||
          (input.throughSequence !== null && x.throughSequence !== input.throughSequence) ||
          !Array.isArray(x.facts) ||
          x.facts.length > input.limit ||
          typeof x.hasMore !== 'boolean'
        )
          throw fail();
        const facts = x.facts.map(fact);
        for (let i = 0; i < facts.length; i++) {
          const f = facts[i]!;
          if (
            JSON.stringify(binding(f as unknown as Record<string, unknown>)) !==
              JSON.stringify(b) ||
            f.sequence !== input.afterSequence + i + 1 ||
            f.sequence > x.throughSequence
          )
            throw fail();
        }
        const last = facts.at(-1)?.sequence ?? input.afterSequence;
        if (
          x.hasMore
            ? facts.length !== input.limit ||
              x.nextAfterSequence !== last ||
              last >= x.throughSequence
            : x.nextAfterSequence !== null || last !== x.throughSequence
        )
          throw fail();
        return {
          contractVersion: TOURNAMENT_FEED_VERSION,
          ...b,
          throughSequence: x.throughSequence,
          facts,
          nextAfterSequence: x.hasMore ? last : null,
          hasMore: x.hasMore,
        };
      },
    );
  }
  recipients(
    original: TournamentFeedFact,
    limit = 50,
    before: string | null = null,
  ): Promise<TournamentFeedRecipientPage> {
    const f = fact(original);
    if (!safe(limit) || limit < 1 || limit > 50) throw fail();
    const previous = before === null ? null : cursor(before);
    if (previous && previous.factHash !== f.factHash) throw fail();
    return this.call('recipients', { version: 1, fact: f, limit, cursor: before }, (raw) => {
      const x = obj(
        raw,
        'candidates,contractVersion,fact,hasMore,nextCursor,snapshotHash,throughSequence',
      );
      if (
        x.contractVersion !== TOURNAMENT_FEED_VERSION ||
        !safe(x.throughSequence) ||
        x.throughSequence < f.sequence ||
        !hash(x.snapshotHash) ||
        !Array.isArray(x.candidates) ||
        x.candidates.length > limit ||
        typeof x.hasMore !== 'boolean'
      )
        throw fail();
      sameFact(x.fact, f);
      if (
        previous &&
        (previous.snapshotHash !== x.snapshotHash || previous.throughSequence !== x.throughSequence)
      )
        throw fail();
      const candidates = x.candidates.map(recipient);
      let prior = previous?.afterWitnessHash ?? '';
      for (const p of candidates) {
        if (p.witnessHash <= prior || p.capturedReadThroughSequence >= f.sequence) throw fail();
        prior = p.witnessHash;
      }
      if (x.hasMore) {
        const next = cursor(x.nextCursor);
        if (
          next.factHash !== f.factHash ||
          next.snapshotHash !== x.snapshotHash ||
          next.throughSequence !== x.throughSequence ||
          next.afterWitnessHash < prior ||
          next.afterWitnessHash <= (previous?.afterWitnessHash ?? '')
        )
          throw fail();
      } else if (x.nextCursor !== null) throw fail();
      return {
        contractVersion: TOURNAMENT_FEED_VERSION,
        fact: f,
        throughSequence: x.throughSequence,
        snapshotHash: x.snapshotHash,
        candidates,
        nextCursor: x.hasMore ? (x.nextCursor as string) : null,
        hasMore: x.hasMore,
      };
    });
  }
  async eligibility(
    original: TournamentFeedFact,
    candidate: TournamentFeedRecipient,
  ): Promise<TournamentFeedEligibility> {
    return (await this.eligibilityWithIdentity(original, candidate)).observation;
  }
  /** Keep exactly the mapping used for this owner proof; never combine a second identity snapshot. */
  async eligibilityWithIdentity(original: TournamentFeedFact, candidate: TournamentFeedRecipient) {
    const f = fact(original),
      r = recipient(candidate);
    // Local identity failures never trip a shared owner-dependency breaker.
    const identity = await this.options.resolve(f.tournamentId, r.witness);
    if (
      !uuid(identity.userId) ||
      !uuid(identity.providerMappingId) ||
      identity.ownerTenantKey !== this.options.ownerTenantKey ||
      !/^[A-Za-z0-9._:-]{1,200}$/.test(identity.providerClientId) ||
      !safe(identity.observedAt) ||
      identity.observedAt > this.now() ||
      this.now() - identity.observedAt >= 5000
    )
      throw new TournamentNotificationFeedError(
        'TOURNAMENT_NOTIFICATION_IDENTITY_UNAVAILABLE',
        false,
      );
    if (
      r.witness.kind === 'PARTICIPANT'
        ? digest('tournament-local-actor:v1', [
            identity.ownerTenantKey,
            identity.providerClientId,
          ]) !== r.witness.actorHash
        : r.witness.selectedUserId !== identity.userId
    )
      throw new TournamentNotificationFeedError(
        'TOURNAMENT_NOTIFICATION_IDENTITY_UNAVAILABLE',
        false,
      );
    const attestation = {
      userId: identity.userId,
      ownerTenantKey: identity.ownerTenantKey,
      providerClientId: identity.providerClientId,
      observedAt: identity.observedAt,
    };
    const observation = await this.call<TournamentFeedEligibility>(
      'eligibility',
      { version: 1, fact: f, recipient: r, identity: attestation },
      (raw) => {
        const x = obj(
          raw,
          'baselineSequence,code,contractVersion,decision,fact,observedAt,userId,validUntil,witnessHash',
        );
        sameFact(x.fact, f);
        if (
          x.contractVersion !== TOURNAMENT_FEED_VERSION ||
          x.userId !== identity.userId ||
          x.witnessHash !== r.witnessHash ||
          x.baselineSequence !== r.baselineSequence ||
          !['ALLOW', 'DENY'].includes(String(x.decision)) ||
          !['ELIGIBLE', 'CURRENT_CONTEXT_CHANGED', 'AUTHOR', 'READ', 'BASELINE'].includes(
            String(x.code),
          ) ||
          (x.decision === 'ALLOW') !== (x.code === 'ELIGIBLE') ||
          !safe(x.observedAt) ||
          !safe(x.validUntil) ||
          x.observedAt > this.now() ||
          x.validUntil <= this.now() ||
          x.validUntil > x.observedAt + 5000 ||
          x.validUntil > identity.observedAt + 5000 ||
          this.now() - identity.observedAt >= 5000 ||
          (x.decision === 'ALLOW' && identity.userId === f.authorUserId)
        )
          throw fail();
        return {
          contractVersion: TOURNAMENT_FEED_VERSION,
          fact: f,
          userId: identity.userId,
          witnessHash: r.witnessHash,
          baselineSequence: r.baselineSequence,
          decision: x.decision as 'ALLOW' | 'DENY',
          code: x.code as TournamentFeedEligibility['code'],
          observedAt: x.observedAt,
          validUntil: x.validUntil,
        };
      },
    );
    return {
      observation,
      identity: { ...identity },
      fresh: () =>
        this.now() >= identity.observedAt &&
        this.now() >= observation.observedAt &&
        this.now() < observation.validUntil &&
        this.now() - identity.observedAt < 5000,
    };
  }
  /** Concrete page adapter: DENY for an organizer never terminalizes another participant candidate. */
  async resolveRecipientPage(f: TournamentFeedFact, limit = 50, before: string | null = null) {
    const page = await this.recipients(f, limit, before),
      allowed: { recipient: TournamentFeedRecipient; observation: TournamentFeedEligibility }[] =
        [],
      seen = new Map<string, string>();
    for (const r of page.candidates) {
      const observation = await this.eligibility(page.fact, r);
      if (observation.decision === 'ALLOW') {
        if (seen.has(observation.userId)) {
          if (seen.get(observation.userId) !== r.witnessHash) throw fail();
          continue;
        }
        seen.set(observation.userId, r.witnessHash);
        allowed.push({ recipient: r, observation });
      }
    }
    if (allowed.some((x) => x.observation.validUntil <= this.now())) throw fail();
    return {
      fact: page.fact,
      snapshotHash: page.snapshotHash,
      throughSequence: page.throughSequence,
      allowed,
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
    };
  }
}
export function tournamentNotificationOwnerFromEnvironment(
  env: NodeJS.ProcessEnv,
  resolve: TournamentFeedOptions['resolve'],
  fetchImplementation?: typeof fetch,
): TournamentNotificationOwnerClient | null {
  if (env.TOURNAMENT_CHAT_NOTIFICATION_ENABLED !== 'true') return null;
  const file = env.TOURNAMENT_CHAT_NOTIFICATION_PRIVATE_KEY_FILE;
  if (!file) throw fail();
  const bytes = readFileSync(file);
  if (bytes.length > 16384) throw fail();
  return new TournamentNotificationOwnerClient({
    baseUrl: env.TOURNAMENT_CHAT_NOTIFICATION_OWNER_BASE_URL ?? '',
    tenantId: env.TOURNAMENT_CHAT_NOTIFICATION_TENANT_ID ?? '',
    tenantKey: env.TOURNAMENT_CHAT_NOTIFICATION_TENANT_KEY ?? '',
    ownerTenantKey: env.TOURNAMENT_CHAT_NOTIFICATION_OWNER_TENANT_KEY ?? '',
    issuer: env.TOURNAMENT_CHAT_NOTIFICATION_ISSUER ?? '',
    kid: env.TOURNAMENT_CHAT_NOTIFICATION_KEY_ID ?? '',
    privateKey: createPrivateKey(bytes),
    resolve,
    ...(fetchImplementation ? { fetchImplementation } : {}),
  });
}
