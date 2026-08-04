import { createHash } from 'node:crypto';

import { z } from 'zod';

export type VivaUpcomingBookingKind = 'GAME' | 'TRAINING' | 'TOURNAMENT';

export interface VivaUpcomingBookingSource {
  readonly bookingRef: string;
  readonly exerciseRef?: string;
  readonly kind: VivaUpcomingBookingKind;
  readonly title: string;
  readonly startsAt: string;
  readonly endsAt?: string;
  readonly venue: string;
  readonly status: 'confirmed' | 'waitlist' | 'payment_required';
  readonly participantsCount?: number;
  readonly openSlots?: number;
}

const externalRefSchema = z.union([
  z.string().trim().min(1).max(200),
  z.number().finite().transform(String),
]);
const namedElementSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  name: z.string().trim().min(1).max(300),
});
const activeBookingSchema = z.object({
  id: externalRefSchema,
  isCancelled: z.boolean(),
});
const activeBookingsSchema = z.object({
  content: z.array(activeBookingSchema).max(1000),
});
const transactionSchema = z
  .object({
    transactionStatus: z.string().trim().min(1).max(80),
  })
  .nullish();
const exerciseSchema = z.object({
  id: externalRefSchema.optional(),
  timeFrom: z.string().datetime({ offset: true }),
  timeTo: z.string().datetime({ offset: true }).optional(),
  inWaitlist: z.boolean().default(false),
  clientsCount: z.number().int().nonnegative().max(10_000).optional(),
  maxClientsCount: z.number().int().nonnegative().max(10_000).optional(),
  direction: namedElementSchema,
  type: namedElementSchema,
  studio: z.object({
    name: z.string().trim().min(1).max(300),
    address: z.string().trim().max(500).nullish(),
  }),
  room: z
    .object({
      name: z.string().trim().min(1).max(300),
    })
    .optional(),
});
const bookingDetailsSchema = z.object({
  id: externalRefSchema,
  isCancelled: z.boolean(),
  transactionStatus: transactionSchema,
  exercise: exerciseSchema.optional(),
});
const clientAssistedPayloadSchema = z
  .object({
    bookings: activeBookingsSchema,
    details: z.array(bookingDetailsSchema).max(1000),
    complete: z.boolean().default(true),
  })
  .strict();

const OPEN_GAME_DIRECTION_IDS = new Set(['4588']);
const OPEN_GAME_TYPE_IDS = new Set(['1613']);
const GROUP_TRAINING_TYPE_IDS = new Set(['605', '847', '963', '1208']);
const TOURNAMENT_DIRECTION_IDS = new Set(['2617', '3284', '4769', '5278']);
const TOURNAMENT_TYPE_IDS = new Set(['839', '1013']);
const PAYMENT_REQUIRED_STATUSES = new Set(['UNPAID', 'WAITING', 'PARTIALLY_PAID']);

function normalizeMarker(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replaceAll('ё', 'е')
    .replace(/[^a-z0-9а-я]+/g, '');
}

function classifyExercise(
  exercise: z.infer<typeof exerciseSchema>,
): VivaUpcomingBookingKind | null {
  const typeId = exercise.type.id === undefined ? undefined : String(exercise.type.id);
  const directionId =
    exercise.direction.id === undefined ? undefined : String(exercise.direction.id);
  if (
    (typeId && OPEN_GAME_TYPE_IDS.has(typeId)) ||
    (directionId && OPEN_GAME_DIRECTION_IDS.has(directionId))
  ) {
    return 'GAME';
  }
  if (
    (typeId && TOURNAMENT_TYPE_IDS.has(typeId)) ||
    (directionId && TOURNAMENT_DIRECTION_IDS.has(directionId))
  ) {
    return 'TOURNAMENT';
  }
  if (typeId && GROUP_TRAINING_TYPE_IDS.has(typeId)) return 'TRAINING';

  const markers = [normalizeMarker(exercise.direction.name), normalizeMarker(exercise.type.name)];
  if (
    markers.some((marker) =>
      [
        'турнир',
        'tournament',
        'американо',
        'americano',
        'мексикано',
        'mexicano',
        'roundrobin',
      ].some((word) => marker.includes(word)),
    )
  ) {
    return 'TOURNAMENT';
  }
  if (
    markers.some((marker) =>
      ['трен', 'training', 'coach', 'групп', 'group'].some((word) => marker.includes(word)),
    )
  ) {
    return 'TRAINING';
  }
  if (
    markers.some((marker) =>
      ['свояигра', 'открытаяигра', 'opengame', 'сплит', 'split', 'игра', 'game'].some((word) =>
        marker.includes(word),
      ),
    )
  ) {
    return 'GAME';
  }
  return null;
}

function bookingStatus(
  detail: z.infer<typeof bookingDetailsSchema>,
): VivaUpcomingBookingSource['status'] {
  if (detail.exercise?.inWaitlist) return 'waitlist';
  if (
    detail.transactionStatus &&
    PAYMENT_REQUIRED_STATUSES.has(detail.transactionStatus.transactionStatus)
  ) {
    return 'payment_required';
  }
  return 'confirmed';
}

function venue(exercise: z.infer<typeof exerciseSchema>): string {
  return [exercise.studio.name, exercise.room?.name, exercise.studio.address]
    .map((value) => value?.trim())
    .filter(Boolean)
    .join(' · ')
    .slice(0, 160);
}

/** Stable, provider-free identifier for an ephemeral PadlHub read snapshot. */
export function vivaReadSnapshotUuid(
  namespace: 'booking' | 'exercise',
  externalId: string,
): string {
  const bytes = Buffer.from(
    createHash('sha256')
      .update(`phub-viva-booking-snapshot-v1:${namespace}:${externalId}`)
      .digest('hex'),
    'hex',
  ).subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Validates the list/details pair and returns integration-only source records.
 * Callers must map or pseudonymize both refs before crossing a public API boundary.
 */
export function normalizeVivaUpcomingBookingPayload(
  payload: unknown,
  options: { readonly now?: Date } = {},
): readonly VivaUpcomingBookingSource[] {
  const parsed = clientAssistedPayloadSchema.parse(payload);
  const activeIds = new Set(
    parsed.bookings.content.filter((booking) => !booking.isCancelled).map((booking) => booking.id),
  );
  const now = options.now?.getTime() ?? Date.now();
  return parsed.details
    .filter(
      (detail) =>
        activeIds.has(detail.id) &&
        !detail.isCancelled &&
        detail.exercise &&
        Date.parse(detail.exercise.timeFrom) >= now,
    )
    .flatMap<VivaUpcomingBookingSource>((detail) => {
      const exercise = detail.exercise;
      if (!exercise) return [];
      const kind = classifyExercise(exercise);
      if (!kind) return [];
      return [
        {
          bookingRef: detail.id,
          ...(exercise.id === undefined ? {} : { exerciseRef: exercise.id }),
          kind,
          title: (exercise.type.name || exercise.direction.name).slice(0, 160),
          startsAt: exercise.timeFrom,
          ...(exercise.timeTo ? { endsAt: exercise.timeTo } : {}),
          venue: venue(exercise) || 'ПаделХАБ',
          status: bookingStatus(detail),
          ...(exercise.clientsCount === undefined
            ? {}
            : { participantsCount: exercise.clientsCount }),
          ...(exercise.clientsCount === undefined || exercise.maxClientsCount === undefined
            ? {}
            : {
                openSlots: Math.max(
                  0,
                  Math.min(4, exercise.maxClientsCount - exercise.clientsCount),
                ),
              }),
        },
      ];
    })
    .sort(
      (left, right) =>
        left.startsAt.localeCompare(right.startsAt) ||
        left.bookingRef.localeCompare(right.bookingRef),
    )
    .slice(0, 50);
}

/** Whether the bounded browser read covered every provider booking page. */
export function isVivaUpcomingBookingPayloadComplete(payload: unknown): boolean {
  return clientAssistedPayloadSchema.parse(payload).complete;
}
