import { z } from 'zod';

export interface DelegatedAvailableSlot {
  readonly id: string;
  readonly stationId: string;
  readonly spaceId: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly trustLevel: 'unverified';
}

const delegatedSlotSchema = z.object({
  id: z.union([z.string(), z.number()]),
  station_id: z.union([z.string(), z.number()]),
  space_id: z.union([z.string(), z.number()]),
  starts_at: z.string(),
  ends_at: z.string(),
});

export function normalizeDelegatedAvailability(input: unknown): readonly DelegatedAvailableSlot[] {
  return z
    .array(delegatedSlotSchema)
    .parse(input)
    .map((slot) => ({
      id: String(slot.id),
      stationId: String(slot.station_id),
      spaceId: String(slot.space_id),
      startsAt: slot.starts_at,
      endsAt: slot.ends_at,
      trustLevel: 'unverified',
    }));
}

export const DIRECT_VIVA_CLIENT_RULES = {
  readOnly: true,
  acceptsSystemApiKey: false,
  trustedForCommands: false,
} as const;
