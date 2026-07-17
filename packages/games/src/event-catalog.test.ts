import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import {
  GAME_DOMAIN_EVENT_TYPES,
  GAME_INTERNAL_COMMAND_TYPES,
  consumersForGameEvent,
  gameDomainEventSchema,
  gameInternalCommandSchema,
  type GameDomainEventType,
  type GameInternalCommandType,
} from './index.js';

interface InternalContractDocument {
  readonly paths: Readonly<Record<string, unknown>>;
  readonly components: {
    readonly schemas: Readonly<
      Record<
        string,
        {
          readonly enum?: readonly string[];
          readonly properties?: Readonly<Record<string, unknown>>;
        }
      >
    >;
  };
}

const internalContractPath = new URL(
  '../../../contracts/openapi/internal/v1/games.yaml',
  import.meta.url,
);
const internalContract = parse(
  readFileSync(internalContractPath, 'utf8'),
) as InternalContractDocument;

const IDS = {
  tenant: '86afbe01-0318-4dd2-bc25-303b7bf0d430',
  game: '6fe9dc1f-87b5-4efd-83a2-5cf9d8070b76',
  event: 'c52ea40f-dc9d-4cf3-ac0c-660ad5fd74d2',
  command: '3be46db9-a6cb-4f73-99f5-20248587c61e',
  actor: 'f75b4e2a-9c98-4b26-85b6-ae58e0edca24',
  player: 'a9c106f7-0db8-4e27-b1e0-298829f94730',
  operation: '3868354b-01cd-4826-b3c6-0619fd6d042a',
  reservation: '8ef58c73-f94c-4e04-97e8-f6057afc0ec1',
  participation: '7ea876b8-c976-40de-8160-9d31a6071931',
  waitlist: '644ae792-4fa5-4b2c-988a-838b3588904e',
  submission: '1f4fc01b-cb02-421b-840d-0e5174e571d8',
  result: 'c531e8fc-6316-492a-8f92-a8812e71c857',
  resource: '075f98b7-014d-446b-a988-a36027178e35',
} as const;

const eventPayloadBase = {
  gameId: IDS.game,
  aggregateRevision: '7',
  causationId: IDS.command,
  actorUserId: IDS.actor,
};

const eventPayloads: Readonly<Record<GameDomainEventType, Readonly<Record<string, unknown>>>> = {
  'game.created.v1': {
    ...eventPayloadBase,
    organizerUserId: IDS.actor,
    kind: 'RATING',
    visibility: 'PUBLIC',
  },
  'game.provisioning.requested.v1': { ...eventPayloadBase, operationId: IDS.operation },
  'game.scheduled.v1': { ...eventPayloadBase, organizerUserId: IDS.actor },
  'game.published.v1': { ...eventPayloadBase, visibility: 'PUBLIC' },
  'game.participation.reserved.v1': {
    ...eventPayloadBase,
    userId: IDS.player,
    reservationId: IDS.reservation,
    expiresAt: '2026-08-01T10:15:00+03:00',
  },
  'game.participation.confirmed.v1': {
    ...eventPayloadBase,
    userId: IDS.player,
    participationId: IDS.participation,
  },
  'game.participation.expired.v1': {
    ...eventPayloadBase,
    userId: IDS.player,
    reservationId: IDS.reservation,
    reasonCode: 'PAYMENT_EXPIRED',
  },
  'game.participation.left.v1': {
    ...eventPayloadBase,
    userId: IDS.player,
    participationId: IDS.participation,
  },
  'game.waitlist.joined.v1': {
    ...eventPayloadBase,
    userId: IDS.player,
    waitlistEntryId: IDS.waitlist,
    position: 1,
  },
  'game.waitlist.left.v1': {
    ...eventPayloadBase,
    userId: IDS.player,
    waitlistEntryId: IDS.waitlist,
    position: 1,
  },
  'game.waitlist.promoted.v1': {
    ...eventPayloadBase,
    userId: IDS.player,
    waitlistEntryId: IDS.waitlist,
    position: 1,
    targetRelation: 'SEAT_RESERVED',
    targetId: IDS.reservation,
  },
  'game.roster.completed.v1': {
    ...eventPayloadBase,
    participantUserIds: [IDS.actor, IDS.player],
  },
  'game.roster.reopened.v1': {
    ...eventPayloadBase,
    participantUserIds: [IDS.actor],
  },
  'game.started.v1': { ...eventPayloadBase, participantUserIds: [IDS.actor, IDS.player] },
  'game.finished.v1': { ...eventPayloadBase, participantUserIds: [IDS.actor, IDS.player] },
  'game.result.submitted.v1': {
    ...eventPayloadBase,
    submissionId: IDS.submission,
    submittedByUserId: IDS.actor,
    requiredConfirmationUserIds: [IDS.player],
  },
  'game.result.confirmed.v1': {
    ...eventPayloadBase,
    resultId: IDS.result,
    participantUserIds: [IDS.actor, IDS.player],
  },
  'game.result.disputed.v1': {
    ...eventPayloadBase,
    submissionId: IDS.submission,
    disputedByUserId: IDS.player,
    participantUserIds: [IDS.actor, IDS.player],
    reasonCode: 'SCORE_INCORRECT',
  },
  'game.cancelled.v1': {
    ...eventPayloadBase,
    participantUserIds: [IDS.actor, IDS.player],
    reasonCode: 'ORGANIZER_REQUEST',
  },
};

const commandPayloads: Readonly<
  Record<GameInternalCommandType, Readonly<Record<string, unknown>>>
> = {
  'game.provisioning.advance.v1': { gameId: IDS.game, operationId: IDS.operation },
  'game.reservation.expire.v1': { gameId: IDS.game, reservationId: IDS.reservation },
  'game.waitlist.promote.v1': { gameId: IDS.game, waitlistEntryId: IDS.waitlist },
  'game.lifecycle.start.v1': { gameId: IDS.game, expectedRevision: '7' },
  'game.lifecycle.finish.v1': { gameId: IDS.game, expectedRevision: '8' },
  'game.integration.reconcile.v1': {
    gameId: IDS.game,
    resourceType: 'PAYMENT_OBLIGATION',
    resourceId: IDS.resource,
  },
};

function event(type: GameDomainEventType, payload = eventPayloads[type]) {
  return {
    id: IDS.event,
    type,
    aggregateId: IDS.game,
    tenantId: IDS.tenant,
    occurredAt: '2026-08-01T10:00:00+03:00',
    correlationId: 'games-event-correlation-1',
    payload,
  };
}

function command(type: GameInternalCommandType, payload = commandPayloads[type]) {
  return {
    id: IDS.command,
    type,
    aggregateId: IDS.game,
    tenantId: IDS.tenant,
    createdAt: '2026-08-01T10:00:00+03:00',
    correlationId: 'games-command-correlation-1',
    causationId: null,
    requestedBy: 'WORKER',
    attempt: 1,
    payload,
  };
}

function propertyKeys(value: unknown): readonly string[] {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(propertyKeys);
  return Object.entries(value as Readonly<Record<string, unknown>>).flatMap(([key, nested]) => [
    key,
    ...propertyKeys(nested),
  ]);
}

describe('game domain event catalog', () => {
  it('validates one strict fixture for every versioned event type', () => {
    expect(Object.keys(eventPayloads)).toEqual(GAME_DOMAIN_EVENT_TYPES);
    for (const type of GAME_DOMAIN_EVENT_TYPES) {
      expect(gameDomainEventSchema.parse(event(type)).type).toBe(type);
    }
  });

  it('uses the standard outbox envelope and keeps causation inside the safe payload', () => {
    const parsed = gameDomainEventSchema.parse(event('game.created.v1'));
    expect(Object.keys(parsed).sort()).toEqual(
      ['aggregateId', 'correlationId', 'id', 'occurredAt', 'payload', 'tenantId', 'type'].sort(),
    );
    expect(parsed.payload).toMatchObject({
      gameId: IDS.game,
      aggregateRevision: '7',
      causationId: IDS.command,
      actorUserId: IDS.actor,
    });
  });

  it('rejects aggregate mismatch, duplicate recipients and extra private/provider fields', () => {
    expect(
      gameDomainEventSchema.safeParse({
        ...event('game.created.v1'),
        aggregateId: IDS.resource,
      }).success,
    ).toBe(false);
    expect(
      gameDomainEventSchema.safeParse(
        event('game.finished.v1', {
          ...eventPayloads['game.finished.v1'],
          participantUserIds: [IDS.player, IDS.player],
        }),
      ).success,
    ).toBe(false);
    expect(
      gameDomainEventSchema.safeParse(
        event('game.created.v1', {
          ...eventPayloads['game.created.v1'],
          providerId: 'forbidden',
        }),
      ).success,
    ).toBe(false);

    const forbiddenKeys = [
      'phone',
      'email',
      'providerId',
      'externalId',
      'vivaId',
      'bookingId',
      'paymentUrl',
      'token',
      'messageBody',
    ];
    for (const payload of Object.values(eventPayloads)) {
      expect(propertyKeys(payload).filter((key) => forbiddenKeys.includes(key))).toEqual([]);
    }
  });

  it('routes every event to a non-empty, duplicate-free consumer set', () => {
    for (const type of GAME_DOMAIN_EVENT_TYPES) {
      const consumers = consumersForGameEvent(type);
      expect(consumers.length, type).toBeGreaterThan(0);
      expect(new Set(consumers).size, type).toBe(consumers.length);
    }
    expect(consumersForGameEvent('game.provisioning.requested.v1')).toEqual([
      'games-process-manager',
    ]);
    expect(consumersForGameEvent('game.result.confirmed.v1')).toContain('rating-projector');
    expect(consumersForGameEvent('game.result.disputed.v1')).not.toContain('rating-projector');
  });
});

describe('game internal command catalog', () => {
  it('validates one strict fixture for every command type', () => {
    expect(Object.keys(commandPayloads)).toEqual(GAME_INTERNAL_COMMAND_TYPES);
    for (const type of GAME_INTERNAL_COMMAND_TYPES) {
      expect(gameInternalCommandSchema.parse(command(type)).type).toBe(type);
    }
  });

  it('rejects aggregate mismatch and provider-owned fields', () => {
    expect(
      gameInternalCommandSchema.safeParse({
        ...command('game.lifecycle.start.v1'),
        aggregateId: IDS.resource,
      }).success,
    ).toBe(false);
    expect(
      gameInternalCommandSchema.safeParse(
        command('game.integration.reconcile.v1', {
          ...commandPayloads['game.integration.reconcile.v1'],
          providerId: 'forbidden',
        }),
      ).success,
    ).toBe(false);
  });
});

describe('Games Internal API compatibility', () => {
  it('keeps command and event type enums aligned with the executable schemas', () => {
    expect(internalContract.components.schemas.GameDomainEventType?.enum).toEqual(
      GAME_DOMAIN_EVENT_TYPES,
    );
    expect(internalContract.components.schemas.GameInternalCommandType?.enum).toEqual(
      GAME_INTERNAL_COMMAND_TYPES,
    );
  });

  it('contains command submission and read-only event inspection only', () => {
    expect(Object.keys(internalContract.paths)).toEqual([
      '/{tenantKey}/game-commands',
      '/{tenantKey}/game-events/{eventId}',
    ]);
  });

  it('keeps forbidden private/provider fields out of the inspection payload', () => {
    const propertyNames = Object.keys(
      internalContract.components.schemas.GameDomainEventPayload?.properties ?? {},
    );
    expect(
      propertyNames.filter((property) =>
        [
          'phone',
          'email',
          'providerId',
          'externalId',
          'vivaId',
          'bookingId',
          'paymentUrl',
          'token',
          'messageBody',
        ].includes(property),
      ),
    ).toEqual([]);
  });
});
