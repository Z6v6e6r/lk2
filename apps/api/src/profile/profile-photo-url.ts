import { profilePhotoDeliveryUrl } from '@phub/domain';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function stableProfilePhotoUrl(input: {
  readonly tenantId: string;
  readonly userId: string;
  readonly currentUrl: unknown;
  readonly deliveryIds: ReadonlyMap<string, string>;
}): unknown {
  const deliveryId = input.deliveryIds.get(input.userId);
  return deliveryId ? profilePhotoDeliveryUrl(input.tenantId, deliveryId) : input.currentUrl;
}

export function gameCardProfilePhotoUserIds(value: unknown): readonly string[] {
  if (!isRecord(value) || !Array.isArray(value.participants)) return [];
  return value.participants.flatMap((participant) =>
    isRecord(participant) && typeof participant.userId === 'string' ? [participant.userId] : [],
  );
}

export function stabilizeGameCardProfilePhotos<T>(
  value: T,
  tenantId: string,
  deliveryIds: ReadonlyMap<string, string>,
): T {
  if (!isRecord(value) || !Array.isArray(value.participants)) return value;
  const participants: readonly unknown[] = value.participants;
  return {
    ...value,
    participants: participants.map((participant) => {
      if (!isRecord(participant) || typeof participant.userId !== 'string') return participant;
      return {
        ...participant,
        avatarUrl: stableProfilePhotoUrl({
          tenantId,
          userId: participant.userId,
          currentUrl: participant.avatarUrl,
          deliveryIds,
        }),
      };
    }),
  };
}

export function homeProfilePhotoUserIds(value: unknown): readonly string[] {
  if (!isRecord(value)) return [];
  const userIds = new Set<string>();
  if (isRecord(value.profile) && typeof value.profile.userId === 'string') {
    userIds.add(value.profile.userId);
  }
  if (Array.isArray(value.upcoming)) {
    for (const item of value.upcoming) {
      if (!isRecord(item) || !Array.isArray(item.participants)) continue;
      for (const participant of item.participants) {
        if (isRecord(participant) && typeof participant.profileId === 'string') {
          userIds.add(participant.profileId);
        }
      }
    }
  }
  return [...userIds];
}

export function stabilizeHomeProfilePhotos(
  value: unknown,
  tenantId: string,
  deliveryIds: ReadonlyMap<string, string>,
): unknown {
  if (!isRecord(value)) return value;
  const profile = isRecord(value.profile)
    ? {
        ...value.profile,
        avatarUrl:
          typeof value.profile.userId === 'string'
            ? stableProfilePhotoUrl({
                tenantId,
                userId: value.profile.userId,
                currentUrl: value.profile.avatarUrl,
                deliveryIds,
              })
            : value.profile.avatarUrl,
      }
    : value.profile;
  const upcomingItems: readonly unknown[] | undefined = Array.isArray(value.upcoming)
    ? value.upcoming
    : undefined;
  const upcoming = upcomingItems
    ? upcomingItems.map((item) => {
        if (!isRecord(item) || !Array.isArray(item.participants)) return item;
        const participants: readonly unknown[] = item.participants;
        return {
          ...item,
          participants: participants.map((participant) => {
            if (!isRecord(participant) || typeof participant.profileId !== 'string') {
              return participant;
            }
            return {
              ...participant,
              avatarUrl: stableProfilePhotoUrl({
                tenantId,
                userId: participant.profileId,
                currentUrl: participant.avatarUrl,
                deliveryIds,
              }),
            };
          }),
        };
      })
    : value.upcoming;
  return { ...value, profile, upcoming };
}
