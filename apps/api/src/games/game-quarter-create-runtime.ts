import type { QuarterCreateResult } from '@phub/api-contracts';
import {
  QuarterCreateError,
  parseQuarterInput,
  qcEqual,
  qcHash,
  type QuarterInput,
  type QuarterOutcome,
} from '@phub/domain/quarter-create';
import type {
  QuarterCreateRepository,
  QuarterActor,
  QuarterAttempt,
  QuarterScope,
} from '@phub/database/quarter-create';
import {
  QuarterPreparationRefused,
  quarterStationActor,
  quarterStationRequest,
  parseStationAdmissionResponse,
  type StationMembershipClient,
  type StationMembershipSigner,
  type QuarterCreateOwnerClient,
} from '@phub/subscription-runtime-adapter';
import type { SubscriptionRuntimeActorDelegationIssuer } from '../subscriptions/subscription-runtime-actor-delegation-issuer.js';
export function createQuarterCreateRuntime(options: {
  enabled: boolean;
  repository: QuarterCreateRepository;
  issuer?: Pick<SubscriptionRuntimeActorDelegationIssuer, 'issueQuarterCreate'>;
  client?: Pick<QuarterCreateOwnerClient, 'prepare' | 'admit' | 'read'>;
  stationMembership?:
    | {
        signer: Pick<StationMembershipSigner, 'issue'>;
        client: Pick<StationMembershipClient, 'admit'>;
      }
    | undefined;
  token?: (actor: QuarterActor) => Promise<{ token: string; expiresAt: string }>;
}) {
  const repo = options.repository;
  const gate = async () => {
    if (
      !options.enabled ||
      !options.client ||
      !options.issuer ||
      !options.token ||
      !(await repo.ready())
    )
      throw new QuarterCreateError();
  };
  const scope = async (actor: QuarterActor, key: string) => {
    if (!/^[A-Za-z0-9._:-]{16,128}$/.test(key) || /[\r\n]/.test(key))
      throw new QuarterCreateError('INVALID_REQUEST', 400);
    return {
      tenantId: actor.tenantId,
      userId: actor.userId,
      keySha256: await qcHash(key),
      idempotencyKey: key,
    };
  };
  const inputOf = (a: QuarterAttempt): QuarterInput => ({
    stationId: a.request.target.stationId,
    courtId: a.request.target.courtId,
    startsAt: a.request.target.startsAt,
    subscriptionId: a.request.subscriptionId,
  });
  async function envelope(
    actor: QuarterActor,
    s: QuarterScope,
    a: QuarterAttempt,
    mode: 'prepare' | 'admit' | 'read',
    recoveryOnly?: true,
  ) {
    if (!a.context) throw new QuarterCreateError();
    const current = await repo.identity(actor, a.request.subscriptionId);
    if (
      !current ||
      !qcEqual(current, {
        providerClientId: a.context.providerClientId,
        providerMappingId: a.context.providerMappingId,
        providerClientSubscriptionId: a.context.providerClientSubscriptionId,
      })
    )
      throw new QuarterCreateError('GAME_QUARTER_CREATE_IDENTITY_CHANGED', 409);
    const actorToken = await options.token!(actor),
      again = await repo.identity(actor, a.request.subscriptionId);
    if (!qcEqual(current, again))
      throw new QuarterCreateError('GAME_QUARTER_CREATE_IDENTITY_CHANGED', 409);
    return {
      operationId: a.id,
      correlationId: actor.correlationId,
      actorToken,
      actorDelegation: await options.issuer!.issueQuarterCreate({
        ...actor,
        mode,
        keySha256: s.keySha256,
        operationId: a.id,
        request: mode === 'prepare' ? a.request : a.admission!,
        context: a.context,
        actorToken,
        ...(recoveryOnly ? { recoveryOnly } : {}),
      }),
    };
  }
  async function view(
    s: QuarterScope,
    a: QuarterAttempt,
    current?: QuarterOutcome,
    mutate = false,
  ): Promise<QuarterCreateResult> {
    const gameId = a.state === 'CONFIRMED' ? await repo.project(s, mutate) : null;
    return {
      contractVersion: 1,
      request: inputOf(a),
      keySha256: s.keySha256,
      operation: {
        id: a.id,
        draftId: a.draftId,
        status:
          a.state === 'PREPARING' || a.state === 'PREPARED'
            ? 'PENDING'
            : a.state === 'DISPATCH_STARTED'
              ? 'UNKNOWN'
              : a.state,
      },
      gameProjection: { status: gameId ? 'AVAILABLE' : 'PENDING', gameId },
      registration: current?.registration ?? { status: 'UNKNOWN', asOf: null },
      reason:
        current?.reason ??
        (a.state === 'DISPATCH_STARTED'
          ? 'GAME_QUARTER_CREATE_RECONCILIATION_REQUIRED'
          : a.state === 'PREPARING' && a.stationMembership
            ? 'GAME_QUARTER_CREATE_STATION_ADMISSION_PENDING'
            : null),
    };
  }
  return {
    async locations(actor: QuarterActor) {
      await gate();
      return repo.locations(actor.tenantId);
    },
    async capability() {
      try {
        await gate();
        return { contractVersion: 1 as const, available: true };
      } catch {
        return { contractVersion: 1 as const, available: false };
      }
    },
    async read(actor: QuarterActor, key: string) {
      if (!(await repo.ready())) throw new QuarterCreateError();
      const s = await scope(actor, key),
        a = await repo.read(s);
      if (!a) return null;
      let current: QuarterOutcome | undefined;
      if (
        options.enabled &&
        options.client &&
        options.issuer &&
        options.token &&
        a.admission &&
        ['DISPATCH_STARTED', 'CONFIRMED', 'REJECTED'].includes(a.state)
      ) {
        try {
          current = await options.client.read(a.admission, await envelope(actor, s, a, 'read'));
        } catch {
          /* Unknown current observation is never historical success. */
        }
      }
      return view(s, a, current);
    },
    async execute(actor: QuarterActor, key: string, raw: unknown, recovery = false) {
      await gate();
      const s = await scope(actor, key),
        q = parseQuarterInput(raw);
      let a = await repo.commandRead(s);
      if (a && !qcEqual(inputOf(a), q))
        throw new QuarterCreateError('GAME_QUARTER_CREATE_KEY_CONFLICT', 409);
      if (!a) {
        if (recovery) {
          a = await repo.begin(s, q, null, actor.correlationId, true);
          return view(s, a);
        }
        const context = await repo.context(actor, q);
        if (!context) throw new QuarterCreateError('GAME_QUARTER_CREATE_CONTEXT_UNAVAILABLE', 409);
        if (Date.parse(q.startsAt) <= Date.now())
          throw new QuarterCreateError('GAME_START_TIME_PASSED', 409);
        a = await repo.begin(s, q, context, actor.correlationId);
      }
      if (a.state === 'PREPARING' && a.stationMembership?.outcome === 'INTENT')
        a = (await repo.expireStationIntent(s, actor.correlationId)) ?? a;
      if (a.state === 'PREPARING') {
        const fresh = await repo.context(actor, q);
        if (!fresh || !qcEqual(fresh, a.context))
          throw new QuarterCreateError('GAME_QUARTER_CREATE_CONTEXT_CHANGED', 409);
        // An adopted attempt cannot downgrade when transport/config is rolled back.
        if (a.stationMembership && !options.stationMembership) return view(s, a);
        const lease = await repo.claimPreparation(s);
        if (!lease) return view(s, a);
        let preparing = false;
        try {
          const auth = await envelope(actor, s, a, 'prepare');
          let admission;
          if (a.stationMembership?.outcome === 'INTENT') admission = a.stationMembership.admission;
          else {
            preparing = true;
            admission = await options.client!.prepare(a.request, auth);
            preparing = false;
          }
          if (a.stationMembership) {
            // Persist before station POST. An ambiguous CAS ACK holds; the next request reads it.
            const saved = await repo.pinStationPreparation(s, lease, admission);
            if (!saved) return view(s, (await repo.read(s)) ?? a);
            a = saved;
            const pinned = a.stationMembership;
            if (pinned?.outcome !== 'INTENT') return view(s, a);
            a = (await repo.expireStationIntent(s, actor.correlationId)) ?? a;
            if (a.state !== 'PREPARING') return view(s, a);
            // Fresh session identity is restrictive only; original authority/epoch never changes.
            await envelope(actor, s, a, 'prepare');
            const stationActor = quarterStationActor(pinned.admission),
              request = await quarterStationRequest(pinned.admission);
            const delegation = options.stationMembership!.signer.issue({
              mode: 'admission',
              actor: stationActor,
              request,
              sessionId: actor.sessionId,
              correlationId: actor.correlationId,
            });
            const response = parseStationAdmissionResponse(
              await options.stationMembership!.client.admit(request, stationActor, {
                delegation,
                correlationId: actor.correlationId,
              }),
              stationActor,
              request,
            );
            a =
              (await repo.prepared(s, lease, pinned.admission, actor.correlationId, {
                ...pinned,
                outcome: 'OWNER_ADMISSION',
                actor: stationActor,
                request,
                response,
              })) ?? a;
            if (a.state === 'PREPARING')
              a = (await repo.expireStationIntent(s, actor.correlationId)) ?? a;
          } else a = (await repo.prepared(s, lease, admission, actor.correlationId)) ?? a;
        } catch (error) {
          if (preparing && error instanceof QuarterPreparationRefused)
            a = (await repo.refusePreparation(s, lease, actor.correlationId)) ?? a;
          // Release only our lease, never the original capsule, attempt, key or owner epoch.
          if (a.stationMembership) a = (await repo.releasePreparation(s, lease)) ?? a;
          return view(s, a);
        }
      }
      if (a.state === 'PREPARED') a = (await repo.expirePrepared(s, actor.correlationId)) ?? a;
      if (a.state === 'PREPARED') {
        const fresh = await repo.context(actor, q);
        if (!fresh || !qcEqual(fresh, a.context))
          throw new QuarterCreateError('GAME_QUARTER_CREATE_CONTEXT_CHANGED', 409);
      }
      if (a.state === 'PREPARED' || a.state === 'DISPATCH_STARTED') {
        // Sign before claiming; any crash/ACK loss after claim remains recovery-only forever.
        await envelope(actor, s, a, 'admit', a.state === 'DISPATCH_STARTED' ? true : undefined);
        const claim = await repo.claimDispatch(s, actor.correlationId);
        if (!claim) return view(s, (await repo.read(s)) ?? a);
        a = claim.attempt;
        let current: QuarterOutcome | undefined;
        try {
          current = await options.client!.admit(
            a.admission!,
            await envelope(actor, s, a, 'admit', claim.recoveryOnly ? true : undefined),
          );
          if (current.receipt)
            a =
              (await repo.complete(
                s,
                claim.token,
                current.receipt,
                current.status === 'REJECTED',
                actor.correlationId,
              )) ?? a;
        } catch {
          /* No automatic retry or replacement key after an ambiguous dispatch. */
        }
        return view(s, a, current, true);
      }
      let current: QuarterOutcome | undefined;
      if (a.admission && (a.state === 'CONFIRMED' || a.state === 'REJECTED')) {
        try {
          current = await options.client!.read(a.admission, await envelope(actor, s, a, 'read'));
        } catch {
          /* Keep immutable receipt, unknown current attendance. */
        }
      }
      return view(s, a, current, true);
    },
  };
}
export type QuarterCreateRuntime = ReturnType<typeof createQuarterCreateRuntime>;
