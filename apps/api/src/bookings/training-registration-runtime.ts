import type { TrainingRegistrationResult } from '@phub/api-contracts';
import {
  TrainingRegistrationError,
  parseTrainingAdmission,
  parseTrainingAuthority,
  parseTrainingReceipt,
  trainingBinding,
  trainingHash,
  trainingRequestHash,
  type TrainingRequest,
  type TrainingAuthority,
} from '@phub/domain/training-registration';
import {
  type TrainingRegistrationRepository,
  type TrainingAttempt,
} from '@phub/database/training-registration';
import {
  TrainingPreparationRefused,
  type TrainingRegistrationOwnerClient,
  type TrainingOwnerOutcome,
} from '@phub/subscription-runtime-adapter';
import type { SubscriptionRuntimeActorDelegationIssuer } from '../subscriptions/subscription-runtime-actor-delegation-issuer.js';
export interface TrainingActor {
  tenantId: string;
  tenantKey: string;
  userId: string;
  sessionId: string;
  correlationId: string;
}
export interface TrainingInput {
  trainingId: string;
  dateHint: string;
  subscriptionId: string;
  idempotencyKey: string;
}
export interface TrainingRegistrationRuntime {
  execute(actor: TrainingActor, input: TrainingInput): Promise<TrainingRegistrationResult>;
  read(
    actor: TrainingActor,
    input: Pick<TrainingInput, 'trainingId' | 'idempotencyKey'>,
  ): Promise<TrainingRegistrationResult>;
}
function view(a: TrainingAttempt, current?: TrainingOwnerOutcome): TrainingRegistrationResult {
  const q = a.request;
  return {
    trainingId: q.trainingId,
    subscriptionId: q.subscriptionId,
    dateHint: q.dateHint,
    operation: {
      id: a.id,
      status:
        a.state === 'CONFIRMED'
          ? 'CONFIRMED'
          : a.state === 'EXPIRED_NOT_DISPATCHED'
            ? 'EXPIRED_NOT_DISPATCHED'
            : a.state === 'REJECTED_NOT_DISPATCHED'
              ? 'REJECTED_NOT_DISPATCHED'
              : ['PREPARING', 'PREPARED'].includes(a.state)
                ? 'PENDING'
                : 'UNKNOWN',
    },
    registration: {
      status: current?.status === 'CONFIRMED' ? 'CONFIRMED' : 'UNKNOWN',
      asOf: current?.asOf ?? null,
    },
    retryAfterSeconds:
      ['EXPIRED_NOT_DISPATCHED', 'REJECTED_NOT_DISPATCHED'].includes(a.state) ||
      current?.status === 'CONFIRMED'
        ? null
        : 15,
  };
}
export function createTrainingRegistrationRuntime(options: {
  enabled: boolean;
  repository: TrainingRegistrationRepository;
  issuer?: Pick<
    SubscriptionRuntimeActorDelegationIssuer,
    'issueTrainingRegistration' | 'trainingSigningIdentity'
  >;
  client?: Pick<TrainingRegistrationOwnerClient, 'prepare' | 'admit' | 'read'>;
  token?: (actor: TrainingActor) => Promise<{ token: string; expiresAt: string }>;
  metric?: (status: 'confirmed' | 'unknown' | 'expired' | 'unavailable') => void;
}): TrainingRegistrationRuntime {
  const { repository } = options;
  async function scope(
    actor: TrainingActor,
    input: Pick<TrainingInput, 'trainingId' | 'idempotencyKey'>,
  ) {
    if (!(await repository.ready())) throw new TrainingRegistrationError();
    return {
      tenantId: actor.tenantId,
      userId: actor.userId,
      trainingId: input.trainingId,
      keySha256: await trainingHash(input.idempotencyKey),
    };
  }
  async function identity(actor: TrainingActor, subscriptionId: string, a?: TrainingAttempt) {
    if (!options.enabled || !options.client || !options.issuer || !options.token)
      throw new TrainingRegistrationError();
    const context = await repository.context({ ...actor, subscriptionId });
    if (!context)
      throw new TrainingRegistrationError('TRAINING_REGISTRATION_IDENTITY_UNAVAILABLE', 403);
    if (a?.authority) {
      const p = a.authority.request.preparation,
        signer = options.issuer.trainingSigningIdentity();
      if (
        p.actor.providerClientId !== context.providerClientId ||
        p.actor.providerMappingId !== context.providerMappingId ||
        p.subscription.providerClientSubscriptionId !== context.providerClientSubscriptionId ||
        a.authority.issuer !== signer.issuer ||
        a.authority.audience !== signer.audience
      )
        throw new TrainingRegistrationError();
    }
    const actorToken = await options.token(actor);
    return { ...context, actorToken };
  }
  async function envelope(
    actor: TrainingActor,
    a: TrainingAuthority,
    ctx: Awaited<ReturnType<typeof identity>>,
    mode: 'admit' | 'read',
    recoveryOnly?: true,
  ) {
    const q = a.request;
    return {
      operationId: q.preparation.operationId,
      actorToken: ctx.actorToken,
      correlationId: actor.correlationId,
      actorDelegation: await options.issuer!.issueTrainingRegistration({
        ...actor,
        ...ctx,
        mode,
        operationId: q.preparation.operationId,
        keySha256: a.keySha256,
        request: q,
        ...(recoveryOnly ? { recoveryOnly } : {}),
      }),
    };
  }
  async function observation(
    actor: TrainingActor,
    a: TrainingAttempt,
    ctx: Awaited<ReturnType<typeof identity>>,
  ) {
    if (!a.authority) throw new TrainingRegistrationError();
    const current = await options.client!.read(
      a.authority,
      await envelope(actor, a.authority, ctx, 'read'),
    );
    if (current.receipt) {
      const receipt = await parseTrainingReceipt(current.receipt, a.authority);
      if (a.receipt && JSON.stringify(a.receipt) !== JSON.stringify(receipt))
        throw new TrainingRegistrationError('TRAINING_REGISTRATION_RECEIPT_CONFLICT', 409);
    }
    return current;
  }
  return {
    async read(actor, input) {
      const s = await scope(actor, input),
        a = await repository.read(s);
      if (!a) throw new TrainingRegistrationError('TRAINING_REGISTRATION_NOT_FOUND', 404);
      if (!a.authority || ['EXPIRED_NOT_DISPATCHED', 'REJECTED_NOT_DISPATCHED'].includes(a.state))
        return view(a);
      try {
        const ctx = await identity(actor, a.request.subscriptionId, a);
        return view(a, await observation(actor, a, ctx));
      } catch {
        options.metric?.('unknown');
        return view(a);
      }
    },
    async execute(actor, input) {
      const s = await scope(actor, input);
      let a = await repository.read(s);
      if (
        a &&
        (a.request.subscriptionId !== input.subscriptionId || a.request.dateHint !== input.dateHint)
      )
        throw new TrainingRegistrationError('TRAINING_REGISTRATION_KEY_CONFLICT', 409);
      if (a && ['EXPIRED_NOT_DISPATCHED', 'REJECTED_NOT_DISPATCHED'].includes(a.state))
        return view(a);
      if (!options.enabled || !options.client || !options.issuer || !options.token) {
        if (a) return view(a);
        throw new TrainingRegistrationError('TRAINING_REGISTRATION_DISABLED');
      }
      if (!a)
        a = await repository.begin(
          s,
          {
            trainingId: input.trainingId,
            subscriptionId: input.subscriptionId,
            dateHint: input.dateHint,
          },
          actor.correlationId,
        );
      let ctx: Awaited<ReturnType<typeof identity>>;
      try {
        ctx = await identity(actor, input.subscriptionId, a);
      } catch {
        return view(a);
      }
      if (a.state === 'PREPARING') {
        const claim = await repository.claimPreparation(s);
        if (!claim?.token) return view(claim?.attempt ?? a);
        a = claim.attempt;
        const request: TrainingRequest = {
          contractVersion: 1,
          action: 'BOOK_GROUP_TRAINING',
          target: { id: a.request.trainingId, dateHint: a.request.dateHint },
          subscriptionId: a.request.subscriptionId,
          paymentIntent: 'USE_SUBSCRIPTION',
        };
        try {
          const operationId = a.id,
            actorDelegation = await options.issuer.issueTrainingRegistration({
              ...actor,
              ...ctx,
              mode: 'prepare',
              operationId,
              keySha256: s.keySha256,
              request,
            });
          const p = await options.client.prepare(request, {
            operationId,
            actorDelegation,
            actorToken: ctx.actorToken,
            correlationId: actor.correlationId,
          });
          if (
            p.operationId !== operationId ||
            p.actor.tenantId !== actor.tenantId ||
            p.actor.userId !== actor.userId ||
            p.actor.providerClientId !== ctx.providerClientId ||
            p.actor.providerMappingId !== ctx.providerMappingId ||
            p.subscription.providerClientSubscriptionId !== ctx.providerClientSubscriptionId ||
            Date.parse(p.observedAt) > Date.now()
          )
            throw new TrainingRegistrationError('TRAINING_REGISTRATION_EVIDENCE_INVALID');
          const admission = await parseTrainingAdmission({ ...request, preparation: p }),
            base = {
              request: admission,
              keySha256: s.keySha256,
              requestSha256: await trainingRequestHash(admission),
              ...options.issuer.trainingSigningIdentity(),
            };
          const settled = await repository.settlePreparation(
            s,
            claim.token,
            await parseTrainingAuthority({ ...base, bindingSha256: await trainingBinding(base) }),
            actor.correlationId,
          );
          if (!settled) return view((await repository.read(s)) ?? a);
          a = settled;
        } catch (error) {
          if (error instanceof TrainingPreparationRefused) {
            const rejected = await repository.settlePreparation(
              s,
              claim.token,
              null,
              actor.correlationId,
            );
            return view(rejected ?? (await repository.read(s)) ?? a);
          }
          return view((await repository.read(s)) ?? a);
        }
      }
      if (!a.authority || !a.authoritySha256) return view(a);
      const original = a.authority.request.preparation;
      if (
        original.actor.providerMappingId !== ctx.providerMappingId ||
        original.actor.providerClientId !== ctx.providerClientId ||
        original.subscription.providerClientSubscriptionId !== ctx.providerClientSubscriptionId
      )
        return view(a);
      let current: TrainingOwnerOutcome | undefined;
      if (a.state !== 'PREPARED') {
        try {
          current = await observation(actor, a, ctx);
        } catch {
          current = undefined;
        }
        if (a.state === 'CONFIRMED') return view(a, current);
      }
      const claimed = await repository.claim(s, actor.correlationId);
      if (!claimed) return view(a);
      a = claimed.attempt;
      if (a.state === 'EXPIRED_NOT_DISPATCHED') {
        options.metric?.('expired');
        return view(a);
      }
      if (!claimed.token || !a.authority || !a.authoritySha256) return view(a, current);
      try {
        if (!current?.receipt)
          current = await options.client.admit(
            a.authority.request,
            a.authority,
            await envelope(actor, a.authority, ctx, 'admit', claimed.recovery ? true : undefined),
          );
        if (current.receipt) {
          const receipt = await parseTrainingReceipt(current.receipt, a.authority);
          const done = await repository.complete(
            s,
            claimed.token,
            a.authoritySha256,
            receipt,
            actor.correlationId,
          );
          if (done) {
            options.metric?.('confirmed');
            return view(done, current);
          }
        }
      } catch {
        options.metric?.('unknown');
      }
      const latest = await repository.read(s);
      return view(latest ?? a);
    },
  };
}
