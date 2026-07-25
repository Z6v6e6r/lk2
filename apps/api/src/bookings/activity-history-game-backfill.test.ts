import type { LegacyGameImportRepository } from '@phub/database';
import {
  localVivaProfileAssociationId,
  localVivaExerciseAssociationId,
  type LegacyGameSourceSnapshot,
} from '@phub/legacy-games-adapter';
import { describe, expect, it, vi } from 'vitest';

import { ActivityHistoryGameBackfill } from './activity-history-game-backfill.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const userId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const exerciseId = '21111111-1111-4111-8111-111111111111';
const vivaProfileId = '31111111-1111-4111-8111-111111111111';
const gameId = '33333333-3333-4333-8333-333333333333';

function snapshot(): LegacyGameSourceSnapshot {
  const participantId = vivaProfileId;
  return {
    externalId: 'a'.repeat(64),
    externalVersion: 'b'.repeat(64),
    vivaExerciseExternalId: localVivaExerciseAssociationId(exerciseId),
    title: 'Открытая игра',
    kind: 'FRIENDLY',
    visibility: 'PRIVATE',
    cancelled: false,
    startsAt: '2026-07-20T06:00:00.000Z',
    endsAt: '2026-07-20T07:00:00.000Z',
    timezone: 'Europe/Moscow',
    station: {
      externalId: 'c'.repeat(64),
      name: 'Терехово',
      courtExternalId: 'd'.repeat(64),
      courtName: 'Открытый корт №6',
    },
    capacity: 4,
    waitlistEnabled: true,
    paymentMode: 'SPLIT',
    levelFrom: null,
    levelTo: null,
    organizerExternalId: participantId,
    participants: [
      {
        externalId: participantId,
        displayName: 'Alexey Sergeev',
        level: 'C',
        levelValue: 3.5,
        role: 'ORGANIZER',
        paymentState: 'PAID',
        avatarSourceUrl: null,
      },
    ],
  };
}

describe('ActivityHistoryGameBackfill', () => {
  it('imports a Viva-proven CUP game, binds the viewer and projects it immediately', async () => {
    const source = { readByVivaExerciseIds: vi.fn(() => Promise.resolve([snapshot()])) };
    const importSnapshots = vi.fn(() =>
      Promise.resolve({
        tenantId,
        imported: [{ gameId, projectionEventId: 'event-1' }],
        existing: [],
        skipped: 0,
      }),
    );
    const repository = {
      refreshVivaExerciseGameLifecycles: () => Promise.resolve([]),
      resolveVivaProfileExternalId: () => Promise.resolve(vivaProfileId),
      resolveViewerPhoneE164: () => Promise.resolve('+79990000001'),
      importSnapshots,
    } as unknown as LegacyGameImportRepository;
    const projectGameCard = vi.fn(() => Promise.resolve('applied'));
    const backfill = new ActivityHistoryGameBackfill({
      tenantKey: 'local-padel',
      source,
      repository,
      projectGameCard,
    });

    await expect(
      backfill.run({
        tenantId,
        userId,
        correlationId: 'history-backfill-test',
        exerciseOccurrences: [
          { exerciseExternalId: exerciseId, startsAt: '2026-07-20T06:00:00.000Z' },
          { exerciseExternalId: exerciseId, startsAt: '2026-07-20T06:00:00.000Z' },
        ],
        now: new Date('2026-07-21T10:00:00.000Z'),
      }),
    ).resolves.toEqual({ requested: 1, matched: 1, imported: 1, existing: 0, viewerBound: true });
    expect(source.readByVivaExerciseIds).toHaveBeenCalledWith({
      exerciseExternalIds: [exerciseId],
      exerciseOccurrences: [
        { exerciseExternalId: exerciseId, startsAt: '2026-07-20T06:00:00.000Z' },
      ],
      limit: 1,
      viewerPhoneE164: '+79990000001',
    });
    expect(importSnapshots).toHaveBeenCalledWith(
      expect.objectContaining({
        participantUserBindings: [
          {
            externalId: vivaProfileId,
            userId,
            proofKind: 'VIVA_PROFILE',
          },
        ],
      }),
    );
    expect(projectGameCard).toHaveBeenCalledWith({ tenantId, eventId: 'event-1', gameId });
  });

  it('prefers the exact CUP viewer-phone participant proof when profile identifiers differ', async () => {
    const phoneAssociation = localVivaProfileAssociationId('cup-player-id');
    const sourceSnapshot = {
      ...snapshot(),
      viewerParticipantExternalId: phoneAssociation,
      participants: [
        {
          ...snapshot().participants[0]!,
          externalId: phoneAssociation,
        },
      ],
    };
    const importSnapshots = vi.fn(() =>
      Promise.resolve({
        tenantId,
        imported: [{ gameId, projectionEventId: 'event-1' }],
        existing: [],
        skipped: 0,
      }),
    );
    const repository = {
      refreshVivaExerciseGameLifecycles: () => Promise.resolve([]),
      resolveVivaProfileExternalId: () => Promise.resolve(vivaProfileId),
      resolveViewerPhoneE164: () => Promise.resolve('+79990000001'),
      importSnapshots,
    } as unknown as LegacyGameImportRepository;
    const backfill = new ActivityHistoryGameBackfill({
      tenantKey: 'local-padel',
      source: { readByVivaExerciseIds: () => Promise.resolve([sourceSnapshot]) },
      repository,
      projectGameCard: () => Promise.resolve('applied'),
    });

    await expect(
      backfill.run({
        tenantId,
        userId,
        correlationId: 'history-phone-binding-test',
        exerciseOccurrences: [
          { exerciseExternalId: exerciseId, startsAt: '2026-07-20T06:00:00.000Z' },
        ],
        now: new Date('2026-07-21T10:00:00.000Z'),
      }),
    ).resolves.toMatchObject({ viewerBound: true });
    expect(importSnapshots).toHaveBeenCalledWith(
      expect.objectContaining({
        participantUserBindings: [
          { externalId: phoneAssociation, userId, proofKind: 'VIEWER_PHONE' },
        ],
      }),
    );
  });

  it('projects an already-associated local game even when CUP no longer returns its snapshot', async () => {
    const refreshVivaExerciseGameLifecycles = vi.fn(() =>
      Promise.resolve([{ gameId, projectionEventId: 'lifecycle-event-1' }]),
    );
    const repository = {
      refreshVivaExerciseGameLifecycles,
      resolveVivaProfileExternalId: () => Promise.resolve(undefined),
      resolveViewerPhoneE164: () => Promise.resolve('+79990000001'),
      importSnapshots: vi.fn(),
    } as unknown as LegacyGameImportRepository;
    const projectGameCard = vi.fn(() => Promise.resolve('applied'));
    const backfill = new ActivityHistoryGameBackfill({
      tenantKey: 'local-padel',
      source: { readByVivaExerciseIds: () => Promise.resolve([]) },
      repository,
      projectGameCard,
    });

    await expect(
      backfill.run({
        tenantId,
        userId,
        correlationId: 'history-existing-lifecycle-test',
        exerciseOccurrences: [
          { exerciseExternalId: exerciseId, startsAt: '2026-07-20T06:00:00.000Z' },
        ],
        now: new Date('2026-07-21T10:00:00.000Z'),
      }),
    ).resolves.toEqual({
      requested: 1,
      matched: 0,
      imported: 0,
      existing: 0,
      viewerBound: false,
    });
    expect(refreshVivaExerciseGameLifecycles).toHaveBeenCalledWith({
      tenantId,
      vivaExerciseAssociationIds: [localVivaExerciseAssociationId(exerciseId)],
      correlationId: 'history-existing-lifecycle-test',
      now: new Date('2026-07-21T10:00:00.000Z'),
    });
    expect(projectGameCard).toHaveBeenCalledWith({
      tenantId,
      eventId: 'lifecycle-event-1',
      gameId,
    });
  });
});
