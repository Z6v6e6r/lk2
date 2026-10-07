/**
 * PadlHub-owned community rating formula (`phub-community-rating-v1`).
 *
 * The legacy viewer place came from an external per-community rating snapshot, which meant one heavy
 * third-party read per visible community and no way to explain or recompute a place inside LK2. This
 * module is the replacement formula: a pure, deterministic function of PadlHub's own confirmed result
 * facts (`games.player_set_facts` plus the game kind).
 *
 * The formula is intentionally separate from attribution: it scores one set for one member. Which
 * community a game belongs to, and how the ledger stores and materializes the result, are decided
 * outside this module, so the formula stays testable without a database.
 */

export const PHUB_COMMUNITY_RATING_VERSION = 'phub-community-rating-v1' as const;

export const COMMUNITY_RATING_GAME_KINDS = ['FRIENDLY', 'RATING', 'PRIVATE', 'COACH_GAME'] as const;
export type CommunityRatingGameKind = (typeof COMMUNITY_RATING_GAME_KINDS)[number];

/** One confirmed set of one member. Mirrors the shared columns of `games.player_set_facts`. */
export interface CommunityRatingSetFact {
  readonly userId: string;
  readonly gameId: string;
  readonly resultId: string;
  readonly setNumber: number;
  readonly kind: CommunityRatingGameKind;
  readonly outcome: 'WON' | 'LOST';
  readonly scoreFor: number;
  readonly scoreAgainst: number;
  readonly occurredAt: string;
}

export interface CommunityRatingSettings {
  /** A result keeps half of its weight after this many days. */
  readonly halfLifeDays: number;
  /** A decisive set earns `1 + marginFactor * (delta / maxScore)` instead of a flat point. */
  readonly marginFactor: number;
  /** Weight per game kind. A kind with weight `0` is not rated at all. */
  readonly kindWeights: Readonly<Record<CommunityRatingGameKind, number>>;
  /** Sets inside `activityWindowDays` a member needs before a place is published. */
  readonly minimumSets: number;
  /** Window used for the activity requirement, not for the lifetime score. */
  readonly activityWindowDays: number;
}

export const COMMUNITY_RATING_DEFAULTS: CommunityRatingSettings = {
  halfLifeDays: 60,
  marginFactor: 0.5,
  kindWeights: { RATING: 1, FRIENDLY: 0.5, PRIVATE: 0, COACH_GAME: 0 },
  minimumSets: 3,
  activityWindowDays: 90,
};

export type CommunityRatingErrorCode = 'COMMUNITY_RATING_INPUT_INVALID';

export class CommunityRatingError extends Error {
  public constructor(public readonly code: CommunityRatingErrorCode) {
    super(code);
    this.name = 'CommunityRatingError';
  }
}

export interface CommunityRatingAggregate {
  readonly score: number;
  readonly sets: number;
  readonly lastResultAt: string | null;
}

export interface CommunityRatingStanding extends CommunityRatingAggregate {
  readonly userId: string;
  readonly place: number;
}

export interface AggregateCommunityRatingOptions {
  readonly now: string | number | Date;
  readonly settings?: Partial<CommunityRatingSettings>;
  /** Optional trailing window in days; omitted means the lifetime score. */
  readonly windowDays?: number;
}

export interface RankCommunityRatingOptions {
  readonly settings?: Partial<CommunityRatingSettings>;
}

const MAX_SET_SCORE = 99;
const DECIMALS = 6;
const MILLISECONDS_PER_DAY = 86_400_000;

function invalid(): never {
  throw new CommunityRatingError('COMMUNITY_RATING_INPUT_INVALID');
}

function round(value: number): number {
  const factor = 10 ** DECIMALS;
  return Math.round(value * factor) / factor;
}

function toMillis(value: string | number | Date): number {
  const millis =
    value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(millis)) invalid();
  return millis;
}

function normalizeSettings(settings: Partial<CommunityRatingSettings> | undefined) {
  const merged = {
    ...COMMUNITY_RATING_DEFAULTS,
    ...settings,
    kindWeights: { ...COMMUNITY_RATING_DEFAULTS.kindWeights, ...settings?.kindWeights },
  } satisfies CommunityRatingSettings;
  const weights = COMMUNITY_RATING_GAME_KINDS.map((kind) => merged.kindWeights[kind]);
  if (
    !Number.isFinite(merged.halfLifeDays) ||
    merged.halfLifeDays <= 0 ||
    !Number.isFinite(merged.marginFactor) ||
    merged.marginFactor < 0 ||
    !Number.isInteger(merged.minimumSets) ||
    merged.minimumSets < 1 ||
    !Number.isInteger(merged.activityWindowDays) ||
    merged.activityWindowDays < 1 ||
    weights.some((weight) => !Number.isFinite(weight) || weight < 0)
  ) {
    invalid();
  }
  return merged;
}

function assertSetFact(fact: CommunityRatingSetFact): void {
  if (
    typeof fact.userId !== 'string' ||
    fact.userId.length === 0 ||
    typeof fact.gameId !== 'string' ||
    fact.gameId.length === 0 ||
    typeof fact.resultId !== 'string' ||
    fact.resultId.length === 0 ||
    !Number.isInteger(fact.setNumber) ||
    fact.setNumber < 1 ||
    !COMMUNITY_RATING_GAME_KINDS.includes(fact.kind) ||
    (fact.outcome !== 'WON' && fact.outcome !== 'LOST') ||
    !Number.isInteger(fact.scoreFor) ||
    !Number.isInteger(fact.scoreAgainst) ||
    fact.scoreFor < 0 ||
    fact.scoreFor > MAX_SET_SCORE ||
    fact.scoreAgainst < 0 ||
    fact.scoreAgainst > MAX_SET_SCORE ||
    // A padel set cannot end level; the canonical result projection enforces the same rule.
    fact.scoreFor === fact.scoreAgainst ||
    !Number.isFinite(Date.parse(fact.occurredAt))
  ) {
    invalid();
  }
}

function setPointsFor(fact: CommunityRatingSetFact, settings: CommunityRatingSettings): number {
  assertSetFact(fact);
  const kindWeight = settings.kindWeights[fact.kind];
  if (kindWeight === 0) return 0;
  const outcomeValue = fact.outcome === 'WON' ? 1 : 0;
  const highest = Math.max(fact.scoreFor, fact.scoreAgainst, 1);
  const margin =
    1 + settings.marginFactor * (Math.abs(fact.scoreFor - fact.scoreAgainst) / highest);
  return round(outcomeValue * margin * kindWeight);
}

function decayForAgeDays(ageDays: number, settings: CommunityRatingSettings): number {
  if (ageDays <= 0) return 1;
  return 0.5 ** (ageDays / settings.halfLifeDays);
}

/**
 * Time-independent points for one confirmed set. Recency is applied by
 * {@link aggregateCommunityRating}, so a stored fact never has to be rewritten as it ages.
 */
export function communityRatingSetPoints(
  fact: CommunityRatingSetFact,
  settings?: Partial<CommunityRatingSettings>,
): number {
  return setPointsFor(fact, normalizeSettings(settings));
}

/** Share of a result's weight that is still active at `now`; `1` for a result at or after `now`. */
export function communityRatingDecay(
  occurredAt: string,
  now: string | number | Date,
  settings?: Partial<CommunityRatingSettings>,
): number {
  const occurredMillis = Date.parse(occurredAt);
  if (!Number.isFinite(occurredMillis)) invalid();
  const resolved = normalizeSettings(settings);
  return decayForAgeDays((toMillis(now) - occurredMillis) / MILLISECONDS_PER_DAY, resolved);
}

/**
 * Scores every rating-relevant set of one member. Facts whose kind carries weight `0` are ignored
 * completely — they neither add points nor count towards the activity requirement.
 */
export function aggregateCommunityRating(
  facts: readonly CommunityRatingSetFact[],
  options: AggregateCommunityRatingOptions,
): CommunityRatingAggregate {
  const resolved = normalizeSettings(options.settings);
  const nowMillis = toMillis(options.now);
  if (
    options.windowDays !== undefined &&
    (!Number.isFinite(options.windowDays) || options.windowDays <= 0)
  ) {
    invalid();
  }
  const windowMillis =
    options.windowDays === undefined ? undefined : options.windowDays * MILLISECONDS_PER_DAY;

  let score = 0;
  let sets = 0;
  let lastResultMillis: number | undefined;
  for (const fact of facts) {
    const points = setPointsFor(fact, resolved);
    if (points === 0) continue;
    const occurredMillis = Date.parse(fact.occurredAt);
    const ageMillis = Math.max(0, nowMillis - occurredMillis);
    if (windowMillis !== undefined && ageMillis > windowMillis) continue;
    score += points * decayForAgeDays(ageMillis / MILLISECONDS_PER_DAY, resolved);
    sets += 1;
    if (lastResultMillis === undefined || occurredMillis > lastResultMillis) {
      lastResultMillis = occurredMillis;
    }
  }
  return {
    score: round(score),
    sets,
    lastResultAt: lastResultMillis === undefined ? null : new Date(lastResultMillis).toISOString(),
  };
}

/**
 * Places the rated members of one community. Members without enough recent activity keep no place,
 * and ties fall back to the member UUID so the order is stable across processes and replays.
 */
export function rankCommunityRating(
  entries: readonly { readonly userId: string; readonly aggregate: CommunityRatingAggregate }[],
  options: RankCommunityRatingOptions = {},
): readonly CommunityRatingStanding[] {
  const resolved = normalizeSettings(options.settings);
  const placed = entries
    .filter((entry) => {
      if (typeof entry.userId !== 'string' || entry.userId.length === 0) invalid();
      return entry.aggregate.sets >= resolved.minimumSets;
    })
    .sort((left, right) => {
      if (left.aggregate.score !== right.aggregate.score) {
        return right.aggregate.score - left.aggregate.score;
      }
      if (left.aggregate.sets !== right.aggregate.sets) {
        return right.aggregate.sets - left.aggregate.sets;
      }
      return left.userId.localeCompare(right.userId);
    });
  return placed.map((entry, index) => ({
    userId: entry.userId,
    place: index + 1,
    score: entry.aggregate.score,
    sets: entry.aggregate.sets,
    lastResultAt: entry.aggregate.lastResultAt,
  }));
}
