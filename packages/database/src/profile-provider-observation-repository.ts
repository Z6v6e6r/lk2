import type { Pool, QueryResultRow } from 'pg';

import { withTenantTransaction } from './connection.js';

export const PROFILE_PROVIDER_OBSERVATION_LEVEL_LABELS = [
  'D',
  'D+',
  'C',
  'C+',
  'B',
  'B+',
  'A',
] as const;

export interface ProfileProviderObservationLevel {
  readonly label: string;
  readonly value: number;
}

/**
 * Last server-accepted provider profile read for one PadlHub user. It carries only the two
 * provider-owned values the native Android profile screen needs (level and money balance); the
 * provider identifier, phone and every other provider field are discarded before storage.
 * Both values are optional because an unreadable provider field is expressed by omitting it,
 * never by publishing a fabricated zero.
 */
export interface ProfileProviderObservation {
  readonly level?: ProfileProviderObservationLevel;
  readonly balanceMinor?: number;
  readonly currency: 'RUB';
  /** Instant at which the server accepted the provider read. Monotonic across writes. */
  readonly observedAt: string;
}

export interface ProfileProviderObservationRepository {
  get(tenantId: string, userId: string): Promise<ProfileProviderObservation | undefined>;
  /**
   * Upserts an observation only when it is newer than the stored one. Older or equal observations
   * are ignored so a delayed relay of the same job cannot roll the visible profile back.
   */
  put(input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly observation: ProfileProviderObservation;
  }): Promise<'accepted' | 'ignored'>;
}

interface ProfileProviderObservationRow extends QueryResultRow {
  readonly level_label: string | null;
  readonly level_value: number | string | null;
  readonly balance_minor: number | string | null;
  readonly currency: string;
  readonly observed_at: Date | string;
}

const LEVEL_LABELS: ReadonlySet<string> = new Set(PROFILE_PROVIDER_OBSERVATION_LEVEL_LABELS);

function levelValue(value: number | string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 10 ? parsed : undefined;
}

// A provider balance may legitimately be negative (debt), so only readability is required.
function balanceMinor(value: number | string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function observationRow(
  row: ProfileProviderObservationRow,
): ProfileProviderObservation | undefined {
  if (row.currency !== 'RUB') return undefined;
  const observedAt = new Date(row.observed_at);
  if (!Number.isFinite(observedAt.getTime())) return undefined;
  const label = row.level_label;
  const value = levelValue(row.level_value);
  // A half-populated level is a corrupt row, not a level to publish: omit it instead of guessing.
  const level =
    label && LEVEL_LABELS.has(label) && value !== undefined ? { label, value } : undefined;
  const balance = balanceMinor(row.balance_minor);
  return {
    ...(level ? { level } : {}),
    ...(balance === undefined ? {} : { balanceMinor: balance }),
    currency: 'RUB',
    observedAt: observedAt.toISOString(),
  };
}

function assertObservation(observation: ProfileProviderObservation): void {
  const balance = observation.balanceMinor;
  if (
    observation.currency !== 'RUB' ||
    !Number.isFinite(Date.parse(observation.observedAt)) ||
    (balance !== undefined && !Number.isSafeInteger(balance)) ||
    (observation.level !== undefined &&
      (!LEVEL_LABELS.has(observation.level.label) ||
        !Number.isFinite(observation.level.value) ||
        observation.level.value < 0 ||
        observation.level.value > 10))
  ) {
    throw new Error('PROFILE_PROVIDER_OBSERVATION_INVALID');
  }
}

export function createProfileProviderObservationRepository(
  pool: Pool,
): ProfileProviderObservationRepository {
  return {
    get(tenantId, userId) {
      return withTenantTransaction(pool, tenantId, async (client) => {
        const result = await client.query<ProfileProviderObservationRow>(
          `select level_label, level_value, balance_minor, currency, observed_at
             from profile.provider_observations
            where tenant_id = $1 and user_id = $2`,
          [tenantId, userId],
        );
        const row = result.rows[0];
        return row ? observationRow(row) : undefined;
      });
    },
    put({ tenantId, userId, observation }) {
      assertObservation(observation);
      return withTenantTransaction(pool, tenantId, async (client) => {
        const result = await client.query<{ readonly observed_at: Date | string }>(
          `insert into profile.provider_observations
             (tenant_id, user_id, level_label, level_value, balance_minor, currency, observed_at,
              updated_at)
           values ($1, $2, $3, $4, $5, $6, $7, now())
           on conflict (tenant_id, user_id) do update
              set level_label = excluded.level_label,
                  level_value = excluded.level_value,
                  balance_minor = excluded.balance_minor,
                  currency = excluded.currency,
                  observed_at = excluded.observed_at,
                  updated_at = now()
            where profile.provider_observations.observed_at < excluded.observed_at
           returning observed_at`,
          [
            tenantId,
            userId,
            observation.level?.label ?? null,
            observation.level?.value ?? null,
            observation.balanceMinor ?? null,
            observation.currency,
            observation.observedAt,
          ],
        );
        return result.rows.length > 0 ? 'accepted' : 'ignored';
      });
    },
  };
}
