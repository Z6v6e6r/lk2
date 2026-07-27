import { describe, expect, it, vi } from 'vitest';

import { VivaCoachGameSummaryAdapter } from './coach-game-summary-source.js';

describe('VivaCoachGameSummaryAdapter', () => {
  it('single-flights schedule reads and strips provider and trainer media identifiers', async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(
      Response.json([
        {
          id: 'external-exercise-id',
          type: { id: 73, name: 'Игра+Тренер' },
          direction: { id: 74, name: 'Игра+Тренер. Уровень C' },
          timeFrom: '2026-07-28T08:00:00+03:00',
          timeTo: '2026-07-28T09:00:00+03:00',
          studio: { id: 'external-studio-id', name: 'Селигерская' },
          room: { id: 'external-room-id', name: 'Корт №2' },
          trainers: [
            {
              id: 'external-trainer-id',
              firstName: 'Кирилл',
              lastName: 'Боев',
              photo: 'https://external.example/trainer-photo-id',
            },
          ],
          maxClientsCount: 3,
          clientsCount: 1,
        },
        {
          id: 'non-coach-event',
          type: { id: 1, name: 'Падел групповая тренировка' },
          direction: { id: 2, name: 'Падел' },
          timeFrom: '2026-07-28T10:00:00+03:00',
          timeTo: '2026-07-28T11:00:00+03:00',
          studio: { name: 'Селигерская' },
          trainers: [],
          maxClientsCount: 8,
          clientsCount: 2,
        },
      ]),
    );
    const adapter = new VivaCoachGameSummaryAdapter({
      apiBaseUrl: 'https://api.vivacrm.test/end-user/api',
      tenantKey: 'tenant-key',
      fetchImplementation,
    });

    const pages = await Promise.all(
      Array.from({ length: 1_000 }, () => adapter.readDate('2026-07-28')),
    );
    const first = pages[0];

    expect(fetchImplementation).toHaveBeenCalledTimes(1);
    expect(pages.every((page) => page === first)).toBe(true);
    expect(first).toEqual([
      expect.objectContaining({
        title: 'Игра с тренером · C',
        stationName: 'Селигерская',
        courtName: 'Корт №2',
        level: 'C',
        trainer: { displayName: 'Кирилл Боев', avatarUrl: null },
        capacity: { total: 3, occupied: 1, open: 2 },
        status: 'JOINABLE',
      }),
    ]);
    expect(JSON.stringify(first)).not.toMatch(
      /external-exercise-id|external-studio-id|external-room-id|external-trainer-id|trainer-photo-id/,
    );
    expect(adapter.readAvatarSource(first?.[0]?.id ?? '')).toBe(
      'https://external.example/trainer-photo-id',
    );
  });
});
