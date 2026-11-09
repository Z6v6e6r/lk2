import { z } from 'zod';

import { LEVEL_FIELD_IDS, levelLabel } from './home-source.js';

/**
 * Server-side contract for the delegated provider profile read that the native Android client
 * relays back (ADR-0023/0020 endpoint exception). The device holds the short-lived token and reads
 * this shape from Viva itself; the payload is untrusted input here, so it is re-validated with the
 * same server schema the Home source uses. Only two provider-owned values survive normalization:
 * the player level and the money balance. Provider id, names, phone, photo and every other field
 * are dropped and never persisted or logged.
 */
const profileObservationCustomFieldSchema = z.object({
  id: z.string().uuid(),
  value: z.array(z.string()),
});

const profileObservationSourceSchema = z.object({
  id: z.string().uuid(),
  // The provider contract types this as an integer, but an unreadable value must degrade to
  // "balance unknown" rather than to a fabricated zero or a whole-result rejection.
  deposit: z.unknown().optional(),
  customFields: z.array(profileObservationCustomFieldSchema),
});

export interface VivaProfileObservationLevel {
  readonly label: string;
  readonly value: number;
  readonly assessmentRequired: false;
}

export interface VivaProfileObservation {
  /** Present only when the provider asserted a readable level in the 0..10 scale. */
  readonly level?: VivaProfileObservationLevel;
  /** Provider balance in minor units. Omitted when the payload carried no readable integer. */
  readonly balanceMinor?: number;
  readonly currency: 'RUB';
}

/** Typed rejection of a relayed provider profile payload; the route maps it to a 400. */
export class VivaProfileObservationInvalidError extends Error {
  public constructor() {
    super('VIVA_PROFILE_OBSERVATION_INVALID');
    this.name = 'VivaProfileObservationInvalidError';
  }
}

function readObservationLevel(
  fields: readonly z.infer<typeof profileObservationCustomFieldSchema>[],
): VivaProfileObservationLevel | undefined {
  for (const fieldId of LEVEL_FIELD_IDS) {
    const raw = fields.find((field) => field.id === fieldId)?.value[0];
    if (!raw) continue;
    const value = Number(raw.replace(',', '.'));
    if (Number.isFinite(value) && value >= 0 && value <= 10) {
      return { label: levelLabel(value), value, assessmentRequired: false };
    }
  }
  return undefined;
}

function readBalanceMinor(deposit: unknown): number | undefined {
  return typeof deposit === 'number' && Number.isSafeInteger(deposit) ? deposit : undefined;
}

export function normalizeVivaProfileObservation(input: unknown): VivaProfileObservation {
  let profile: z.infer<typeof profileObservationSourceSchema>;
  try {
    profile = profileObservationSourceSchema.parse(input);
  } catch {
    throw new VivaProfileObservationInvalidError();
  }
  const level = readObservationLevel(profile.customFields);
  const balanceMinor = readBalanceMinor(profile.deposit);
  return {
    ...(level ? { level } : {}),
    ...(balanceMinor === undefined ? {} : { balanceMinor }),
    currency: 'RUB',
  };
}
