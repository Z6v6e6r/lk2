import type { LocationRecommendationPhoto } from '@phub/locations';
import { describe, expect, it } from 'vitest';

import type { BookingRecommendationItem } from './booking-recommendations.js';
import { withRecommendationCardPhotos } from './recommendation-card-photos.js';

const stationId = 'bd35543d-c565-443a-bd3d-eea68eb2fbe6';
const assetId = '10000000-0000-4000-8000-000000000001';
const photo = (
  eventType: LocationRecommendationPhoto['eventType'],
  isActive = true,
): LocationRecommendationPhoto => ({
  assetId,
  eventType,
  isActive,
  sortOrder: 0,
});
function game(station = stationId, kind = 'FRIENDLY'): BookingRecommendationItem {
  return {
    kind: 'GAME',
    game: { id: 'game-1', kind, station: { id: station, name: 'Терехово' } },
  } as unknown as BookingRecommendationItem;
}
function activity(
  kind: 'TRAINING' | 'TOURNAMENT',
  title = 'Тренировка',
): BookingRecommendationItem {
  return {
    kind,
    activity: {
      id: 'event-1',
      kind,
      title,
      station: { id: 'provider-snapshot', name: 'Терехово' },
    },
  } as unknown as BookingRecommendationItem;
}

describe('station recommendation photo selection', () => {
  it('uses the exact station and type, even when stations have identical names', () => {
    const items = [game(), game('other-station'), game(stationId, 'COACH_GAME')];
    const selected = withRecommendationCardPhotos(
      items,
      new Map([[stationId, [photo('GAME')]]]),
      'local-padel',
    );
    expect(selected[0]?.cardImageUrl).toBe(`/public/api/v1/local-padel/location-media/${assetId}`);
    expect(selected[1]).not.toHaveProperty('cardImageUrl');
    expect(selected[2]).not.toHaveProperty('cardImageUrl');
  });

  it('requires established canonical mappings for activities and uses coach photos for coach games', () => {
    const items = [activity('TRAINING', 'Игра+Тренер')];
    const photos = new Map([[stationId, [photo('COACH_GAME')]]]);
    expect(withRecommendationCardPhotos(items, photos, 'local-padel')[0]).not.toHaveProperty(
      'cardImageUrl',
    );
    expect(
      withRecommendationCardPhotos(
        items,
        photos,
        'local-padel',
        new Map([['event-1', stationId]]),
      )[0]?.cardImageUrl,
    ).toContain(assetId);
    expect(
      withRecommendationCardPhotos(
        [activity('TOURNAMENT')],
        photos,
        'local-padel',
        new Map([['event-1', stationId]]),
      )[0],
    ).not.toHaveProperty('cardImageUrl');
  });

  it('excludes inactive photos and preserves deterministic selection when database ordering changes', () => {
    const first = photo('GAME');
    const second = { ...first, assetId: '10000000-0000-4000-8000-000000000002', sortOrder: 1 };
    const inactive = { ...first, assetId: '10000000-0000-4000-8000-000000000003', isActive: false };
    const select = (list: LocationRecommendationPhoto[]) =>
      withRecommendationCardPhotos([game()], new Map([[stationId, list]]), 'local-padel')[0]
        ?.cardImageUrl;
    expect(select([first, second, inactive])).toBe(select([inactive, second, first]));
    expect(select([first, second, inactive])).not.toContain(inactive.assetId);
    expect(select([inactive])).toBeNull();
    expect(select([])).toBeUndefined();
  });
});
