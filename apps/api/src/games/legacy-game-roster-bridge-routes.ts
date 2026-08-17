import { createHash, timingSafeEqual } from 'node:crypto';

import type {
  GameRosterCommandErrorCode,
  GameRosterRepository,
  LegacyGameRosterBridgeRepository,
} from '@phub/database';
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';

import { sendApiError } from '../http-errors.js';
import {
  LegacyLkIdentityVerificationError,
  type LegacyLkIdentityVerifier,
} from './legacy-lk-identity-verifier.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EXTERNAL_GAME_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const commandSchema = z.discriminatedUnion('command', [
  z
    .object({
      command: z.enum(['JOIN_GAME', 'JOIN_WAITLIST']),
      invitationId: z.string().uuid().optional(),
    })
    .strict(),
  z
    .object({
      command: z.literal('CONFIRM_PAYMENT'),
      reservationId: z.string().uuid(),
      evidence: z
        .object({
          provider: z.literal('VIVA'),
          operationType: z.enum(['TRANSACTION', 'SUBSCRIPTION_BOOKING']),
          operationId: z.string().trim().min(1).max(200),
          bookingId: z.string().trim().min(1).max(200),
          exerciseId: z.string().trim().min(1).max(200).optional(),
          clientPhoneE164: z.string().regex(/^\+[1-9][0-9]{7,14}$/),
          status: z.literal('CONFIRMED'),
          verifiedAt: z.string().datetime({ offset: true }),
          amountMinor: z.number().int().nonnegative().optional(),
          currency: z
            .string()
            .regex(/^[A-Z]{3}$/)
            .optional(),
        })
        .strict(),
    })
    .strict(),
]);

const PUBLIC_ERROR_MESSAGES: Partial<Record<GameRosterCommandErrorCode, string>> = {
  GAME_NOT_FOUND: 'Игра не найдена.',
  GAME_REVISION_CONFLICT: 'Игра уже изменилась. Повторите запись.',
  GAME_NOT_JOINABLE: 'К этой игре сейчас нельзя присоединиться.',
  GAME_JOIN_CUTOFF_PASSED: 'Время записи на игру закончилось.',
  GAME_ALREADY_JOINED: 'Вы уже участвуете в этой игре.',
  GAME_ALREADY_RESERVED: 'Место уже зарезервировано.',
  GAME_ALREADY_WAITLISTED: 'Вы уже в листе ожидания.',
  GAME_FULL: 'В игре нет свободных мест.',
  GAME_WAITLIST_DISABLED: 'Лист ожидания отключён.',
  GAME_WAITLIST_NOT_AVAILABLE: 'Сейчас нельзя встать в лист ожидания.',
  PLAYER_LEVEL_REQUIRED: 'Укажите уровень, чтобы присоединиться.',
  PLAYER_LEVEL_UNKNOWN: 'Не удалось корректно определить ваш уровень.',
  LEVEL_NOT_ALLOWED: 'Эта игра рассчитана на другой уровень.',
  LEVEL_SPORT_MISMATCH: 'Уровень указан для другого вида спорта.',
  LEVEL_SCALE_VERSION_MISMATCH: 'Версия уровня устарела. Обновите уровень.',
  ACTIVITY_LEVEL_UNDEFINED: 'Для игры не настроен диапазон уровней.',
  ACTIVITY_LEVEL_INVALID: 'Диапазон уровней игры настроен некорректно.',
  LEVEL_POLICY_MISCONFIGURED: 'Правило допуска временно настроено некорректно.',
  GAME_NOT_CONFIRMABLE: 'Участие уже нельзя подтвердить.',
  GAME_PAYMENT_EVIDENCE_CONFLICT: 'Данные подтверждения оплаты противоречат сохранённым.',
  GAME_PAYMENT_MODE_MISMATCH: 'Платёж не соответствует способу оплаты игры.',
  GAME_PAYMENT_SNAPSHOT_MISSING: 'Не найдено исходное решение о допуске.',
  GAME_RESERVATION_EXPIRED: 'Срок резерва места истёк.',
  GAME_RESERVATION_NOT_FOUND: 'Резерв места не найден.',
};

function constantTimeEqual(expected: string, supplied: string | undefined): boolean {
  if (!supplied) return false;
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  return (
    expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes)
  );
}

function requestHash(input: {
  readonly command: 'JOIN_GAME' | 'JOIN_WAITLIST' | 'CONFIRM_PAYMENT';
  readonly gameId: string;
  readonly externalGameId: string;
  readonly invitationId?: string;
  readonly reservationId?: string;
  readonly evidence?: unknown;
}): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

function idempotencyKey(request: FastifyRequest): string | undefined {
  const value = request.headers['idempotency-key'];
  return typeof value === 'string' ? value : undefined;
}

export function registerLegacyGameRosterBridgeRoutes(
  app: FastifyInstance,
  options: {
    readonly enabled: boolean;
    readonly integrationToken?: string;
    readonly identityVerifier?: LegacyLkIdentityVerifier;
    readonly contextRepository?: LegacyGameRosterBridgeRepository;
    readonly rosterRepository?: Pick<
      GameRosterRepository,
      'join' | 'joinWaitlist' | 'confirmPayment'
    >;
    readonly commandHandlers: readonly preHandlerHookHandler[];
  },
): void {
  app.post(
    '/internal/api/v1/:tenantKey/legacy-games/:legacyGameId/roster-commands',
    { preHandler: [...options.commandHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (
        !options.enabled ||
        !options.integrationToken ||
        !options.identityVerifier ||
        !options.contextRepository ||
        !options.rosterRepository
      ) {
        return sendApiError(
          request,
          reply,
          503,
          'LEGACY_GAME_BRIDGE_DISABLED',
          'Legacy-маршрутизация записи отключена.',
        );
      }
      const suppliedIntegrationToken = request.headers['x-phub-legacy-roster-token'];
      if (
        typeof suppliedIntegrationToken !== 'string' ||
        !constantTimeEqual(options.integrationToken, suppliedIntegrationToken)
      ) {
        return sendApiError(
          request,
          reply,
          403,
          'LEGACY_GAME_BRIDGE_FORBIDDEN',
          'Legacy-маршрутизация записи недоступна.',
        );
      }
      const authorization = request.headers.authorization;
      if (!authorization || !/^Bearer\s+\S+$/i.test(authorization)) {
        return sendApiError(request, reply, 401, 'LEGACY_AUTH_REQUIRED', 'Требуется авторизация.');
      }
      const params = request.params as {
        readonly tenantKey?: string;
        readonly legacyGameId?: string;
      };
      const tenantKey = params.tenantKey;
      const externalGameId = params.legacyGameId;
      if (!tenantKey || !externalGameId || !EXTERNAL_GAME_ID_PATTERN.test(externalGameId)) {
        return sendApiError(
          request,
          reply,
          400,
          'LEGACY_GAME_ID_INVALID',
          'Некорректный идентификатор игры.',
        );
      }
      const tenantId = request.tenantId;
      const commandIdempotencyKey = idempotencyKey(request);
      if (!tenantId || !commandIdempotencyKey) {
        return sendApiError(
          request,
          reply,
          503,
          'LEGACY_GAME_BRIDGE_CONTEXT_UNAVAILABLE',
          'Legacy-маршрутизация записи временно недоступна.',
        );
      }
      const parsed = commandSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendApiError(
          request,
          reply,
          400,
          'LEGACY_GAME_COMMAND_INVALID',
          'Некорректная команда записи.',
        );
      }

      let actor;
      try {
        actor = await options.identityVerifier.verify(authorization);
      } catch (error) {
        if (error instanceof LegacyLkIdentityVerificationError) {
          return sendApiError(
            request,
            reply,
            error.outcome === 'rejected' ? 401 : 503,
            error.outcome === 'rejected'
              ? 'LEGACY_AUTH_TOKEN_INVALID'
              : 'LEGACY_AUTH_VERIFIER_UNAVAILABLE',
            error.outcome === 'rejected'
              ? 'Сессия недействительна.'
              : 'Проверка сессии временно недоступна.',
          );
        }
        throw error;
      }
      if (actor.tenantKey !== tenantKey) {
        return sendApiError(
          request,
          reply,
          403,
          'LEGACY_TENANT_ACCESS_DENIED',
          'Сессия относится к другой организации.',
        );
      }
      const resolved = await options.contextRepository.resolve({
        tenantId,
        issuer: actor.issuer,
        subject: actor.subject,
        externalGameId,
      });
      if (resolved.outcome === 'actor_not_linked') {
        return sendApiError(
          request,
          reply,
          409,
          'LEGACY_ACTOR_NOT_LINKED',
          'Профиль ещё не связан с PadlHub. Обновите авторизацию.',
        );
      }
      if (resolved.outcome === 'game_not_mapped') {
        return sendApiError(
          request,
          reply,
          409,
          'LEGACY_GAME_NOT_MAPPED',
          'Игра ещё не перенесена в канонический контур.',
        );
      }
      if (
        parsed.data.command === 'CONFIRM_PAYMENT' &&
        parsed.data.evidence.clientPhoneE164 !== resolved.context.player.phoneE164
      ) {
        return sendApiError(
          request,
          reply,
          409,
          'GAME_PAYMENT_ACTOR_MISMATCH',
          'Платёж относится к другому игроку.',
        );
      }
      if (
        parsed.data.command === 'CONFIRM_PAYMENT' &&
        parsed.data.evidence.exerciseId === undefined
      ) {
        request.log.warn(
          {
            event: 'legacy_payment_evidence_exercise_binding_missing',
            tenantId,
            externalGameId,
            providerOperationType: parsed.data.evidence.operationType,
            correlationId: request.id,
          },
          'legacy payment evidence arrived without provider exercise binding',
        );
      }
      const result =
        parsed.data.command === 'CONFIRM_PAYMENT'
          ? await options.rosterRepository.confirmPayment({
              tenantId,
              actorUserId: resolved.context.userId,
              gameId: resolved.context.gameId,
              idempotencyKey: commandIdempotencyKey,
              requestHash: requestHash({
                command: parsed.data.command,
                gameId: resolved.context.gameId,
                externalGameId,
                reservationId: parsed.data.reservationId,
                evidence: parsed.data.evidence,
              }),
              correlationId: request.id,
              reservationId: parsed.data.reservationId,
              evidence: {
                provider: parsed.data.evidence.provider,
                operationType: parsed.data.evidence.operationType,
                operationId: parsed.data.evidence.operationId,
                bookingId: parsed.data.evidence.bookingId,
                ...(parsed.data.evidence.exerciseId
                  ? { exerciseId: parsed.data.evidence.exerciseId }
                  : {}),
                clientPhoneE164: parsed.data.evidence.clientPhoneE164,
                evidenceHash: requestHash({
                  command: parsed.data.command,
                  gameId: resolved.context.gameId,
                  externalGameId,
                  reservationId: parsed.data.reservationId,
                  evidence: parsed.data.evidence,
                }),
                verifiedAt: parsed.data.evidence.verifiedAt,
                verifiedBy: 'LEGACY_NODE_RED',
                ...(parsed.data.evidence.amountMinor === undefined
                  ? {}
                  : { amountMinor: parsed.data.evidence.amountMinor }),
                ...(parsed.data.evidence.currency
                  ? { currency: parsed.data.evidence.currency }
                  : {}),
              },
            })
          : await options.rosterRepository[
              parsed.data.command === 'JOIN_GAME' ? 'join' : 'joinWaitlist'
            ]({
              tenantId,
              actorUserId: resolved.context.userId,
              gameId: resolved.context.gameId,
              idempotencyKey: commandIdempotencyKey,
              requestHash: requestHash({
                command: parsed.data.command,
                gameId: resolved.context.gameId,
                externalGameId,
                ...(parsed.data.invitationId ? { invitationId: parsed.data.invitationId } : {}),
              }),
              correlationId: request.id,
              expectedRevision: resolved.context.gameRevision,
              ...(parsed.data.invitationId ? { invitationId: parsed.data.invitationId } : {}),
            });
      if (result.outcome === 'idempotency_conflict') {
        return sendApiError(
          request,
          reply,
          409,
          'IDEMPOTENCY_KEY_REUSED',
          'Idempotency-Key уже использован для другой команды.',
        );
      }
      if (result.outcome === 'rejected') {
        const message = PUBLIC_ERROR_MESSAGES[result.code];
        if (!message) throw new Error('LEGACY_GAME_BRIDGE_POLICY_ERROR');
        return sendApiError(
          request,
          reply,
          result.code === 'GAME_NOT_FOUND' ? 404 : 409,
          result.code,
          message,
        );
      }
      if (!UUID_PATTERN.test(result.commandId)) {
        throw new Error('LEGACY_GAME_BRIDGE_COMMAND_ID_INVALID');
      }
      return reply.status(result.viewerRelation === 'SEAT_RESERVED' ? 202 : 200).send({
        commandId: result.commandId,
        replayed: result.replayed,
        projection: {
          legacyGameId: externalGameId,
          canonicalGameId: result.gameId,
          aggregateRevision: result.revision,
          relation: result.viewerRelation,
          ...(result.reservationId ? { reservationId: result.reservationId } : {}),
          player: resolved.context.player,
        },
      });
    },
  );
}
