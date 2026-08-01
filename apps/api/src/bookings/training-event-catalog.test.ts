import type { VivaExerciseRecommendation } from '@phub/viva-adapter';
import { describe, expect, it } from 'vitest';

import {
  buildTrainingEventCatalog,
  normalizeTrainingEventCatalogQuery,
  trainingCatalogKind,
  trainingEventCatalogQueryHash,
  type TrainingEventCatalogQuery,
} from './training-event-catalog.js';

const stationOne = '11111111-1111-4111-8111-111111111111';
const stationTwo = '22222222-2222-4222-8222-222222222222';
const coachCategory = '33333333-3333-4333-8333-333333333333';
const groupCategory = '44444444-4444-4444-8444-444444444444';

function activity(
  id: string,
  input: Partial<VivaExerciseRecommendation> = {},
): VivaExerciseRecommendation {
  return {
    id,
    kind: 'TRAINING',
    title: 'Игра+Тренер. Уровень D+',
    startsAt: '2026-08-02T07:00:00.000Z',
    endsAt: '2026-08-02T08:00:00.000Z',
    timezone: 'Europe/Moscow',
    station: { id: stationOne, name: 'Станция 1', shortAddress: null },
    category: { id: coachCategory, name: 'Игра+Тренер. Уровень D+' },
    levelRange: { from: 'D+', to: 'D+' },
    capacity: { total: 3, open: 2 },
    host: { displayName: 'Тренер', avatarUrl: null, role: 'TRAINER' },
    route: `/trainings?event=${id}`,
    ...input,
  };
}

function query(input: Partial<TrainingEventCatalogQuery> = {}): TrainingEventCatalogQuery {
  return {
    surface: 'TRAININGS',
    localDates: ['2026-08-02'],
    kinds: ['COACH_GAME', 'GROUP_TRAINING', 'SPLIT'],
    availability: 'EXCLUDE_FULL',
    limit: 20,
    ...input,
  };
}

describe('training event catalog', () => {
  it('normalizes unordered filters before hashing', () => {
    const first = normalizeTrainingEventCatalogQuery({
      surface: 'TRAININGS',
      localDates: ['2026-08-03', '2026-08-02', '2026-08-02'],
      kinds: ['SPLIT', 'COACH_GAME', 'COACH_GAME'],
      categoryIds: [groupCategory, coachCategory],
      stationIds: [stationTwo, stationOne],
      availability: 'EXCLUDE_FULL',
      limit: 20,
    });
    const second = normalizeTrainingEventCatalogQuery({
      surface: 'TRAININGS',
      localDates: ['2026-08-02', '2026-08-03'],
      kinds: ['COACH_GAME', 'SPLIT'],
      categoryIds: [coachCategory, groupCategory],
      stationIds: [stationOne, stationTwo],
      availability: 'EXCLUDE_FULL',
      limit: 20,
    });
    expect(first).toEqual(second);
    expect(trainingEventCatalogQueryHash(first!)).toBe(trainingEventCatalogQueryHash(second!));
    expect(
      normalizeTrainingEventCatalogQuery({
        surface: 'TRAININGS',
        localDates: ['2026-08-02'],
        kinds: ['COACH_GAME'],
        categoryIds: [],
        stationIds: [],
        availability: 'EXCLUDE_FULL',
        limit: 20,
      }),
    ).toEqual(query({ kinds: ['COACH_GAME'] }));
  });

  it('applies all filters to the complete set before pagination', () => {
    const nonmatches = Array.from({ length: 20 }, (_, index) =>
      activity(`full-${index}`, { capacity: { total: 3, open: 0 } }),
    );
    const match = activity('match');
    const result = buildTrainingEventCatalog({
      activities: [...nonmatches, match],
      query: query({ kinds: ['COACH_GAME'], levelFrom: 'D', levelTo: 'C+' }),
      completedDates: ['2026-08-02'],
      timezone: 'Europe/Moscow',
    });
    expect(result.items.map((item) => item.id)).toEqual(['match']);
    expect(result.metadata.totalMatched).toBe(1);
  });

  it('supports OR filters, local time, levels and stable deduplication', () => {
    const coach = activity('coach');
    const duplicate = activity('coach', { capacity: { total: 3, open: 1 } });
    const group = activity('group', {
      title: 'Групповая тренировка уровень D',
      station: { id: stationTwo, name: 'Станция 2', shortAddress: null },
      category: { id: groupCategory, name: 'Групповая тренировка уровень D' },
      levelRange: { from: 'D', to: 'D' },
      startsAt: '2026-08-02T15:30:00.000Z',
    });
    const noLevel = activity('no-level', { levelRange: null });
    const result = buildTrainingEventCatalog({
      activities: [group, duplicate, noLevel, coach],
      query: query({
        kinds: ['COACH_GAME', 'GROUP_TRAINING'],
        categoryIds: [coachCategory, groupCategory],
        stationIds: [stationOne, stationTwo],
        levelFrom: 'D',
        levelTo: 'D+',
        startsAfterLocal: '10:00',
      }),
      completedDates: ['2026-08-02'],
      timezone: 'Europe/Moscow',
    });
    expect(result.items.map((item) => item.id)).toEqual(['coach', 'group']);
    expect(trainingCatalogKind(group)).toBe('GROUP_TRAINING');
    expect(result.metadata.facets?.stations).toHaveLength(2);
  });

  it('surfaces missing dates as partial without exact totals or facets', () => {
    const result = buildTrainingEventCatalog({
      activities: [activity('available')],
      query: query({ localDates: ['2026-08-02', '2026-08-03'] }),
      completedDates: ['2026-08-02'],
      timezone: 'Europe/Moscow',
    });
    expect(result.state).toBe('PARTIAL');
    expect(result.items).toHaveLength(1);
    expect(result.metadata.totalMatched).toBeNull();
    expect(result.metadata.facets).toBeNull();
    expect(result.metadata.sourceStatus).toEqual([
      {
        source: 'SCHEDULE',
        localDate: '2026-08-02',
        state: 'READY',
        errorCode: null,
      },
      {
        source: 'SCHEDULE',
        localDate: '2026-08-03',
        state: 'UNAVAILABLE',
        errorCode: 'SCHEDULE_READ_INCOMPLETE',
      },
    ]);
  });

  it('uses tenant-local time and keeps unselected kinds in complete facets', () => {
    const coach = activity('coach-midnight', {
      startsAt: '2026-08-01T22:30:00.000Z',
    });
    const group = activity('group-midnight', {
      title: 'Групповая тренировка уровень D',
      category: { id: groupCategory, name: 'Групповая тренировка уровень D' },
      startsAt: '2026-08-01T22:45:00.000Z',
    });
    const result = buildTrainingEventCatalog({
      activities: [group, coach],
      query: query({ kinds: ['COACH_GAME'], startsAfterLocal: '01:00' }),
      completedDates: ['2026-08-02'],
      timezone: 'Europe/Moscow',
    });
    expect(result.items.map((item) => item.id)).toEqual(['coach-midnight']);
    expect(result.metadata.facets?.kinds).toEqual([
      { kind: 'COACH_GAME', count: 1 },
      { kind: 'GROUP_TRAINING', count: 1 },
    ]);
  });
});
