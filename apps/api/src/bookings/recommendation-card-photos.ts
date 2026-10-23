import type { LocationRecommendationPhoto } from '@phub/locations';

import type { BookingRecommendationItem } from './booking-recommendations.js';

/** Photo settings belong to canonical station UUIDs, never display-name aliases. */
export function withRecommendationCardPhotos(
  items: readonly BookingRecommendationItem[],
  photos: ReadonlyMap<string, readonly LocationRecommendationPhoto[]>,
  tenantKey: string | undefined,
  canonicalStationIds?: ReadonlyMap<string, string>,
): readonly BookingRecommendationItem[] {
  if (!tenantKey) return items;
  return items.map((item) => {
    const eventId = item.kind === 'GAME' ? item.game.id : item.activity.id;
    const stationId =
      item.kind === 'GAME' ? item.game.station.id : canonicalStationIds?.get(eventId);
    const eventType =
      item.kind === 'GAME'
        ? item.game.kind === 'COACH_GAME'
          ? 'COACH_GAME'
          : 'GAME'
        : item.kind === 'TRAINING' && /игра\s*\+\s*тренер/iu.test(item.activity.title)
          ? 'COACH_GAME'
          : item.kind;
    const configured = (stationId ? photos.get(stationId) : undefined)?.filter(
      (photo) => photo.eventType === eventType,
    );
    if (!configured?.length) return item;
    const active = configured
      .filter((photo) => photo.isActive)
      .sort(
        (left, right) =>
          left.sortOrder - right.sortOrder || left.assetId.localeCompare(right.assetId),
      );
    let hash = 0;
    for (const char of eventId) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;
    const selected = active[hash % active.length];
    return {
      ...item,
      // Null explicitly disables station photos; omission preserves the existing fallback.
      cardImageUrl: selected
        ? `/public/api/v1/${encodeURIComponent(tenantKey)}/location-media/${selected.assetId}`
        : null,
    };
  });
}
