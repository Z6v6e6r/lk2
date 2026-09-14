import type { HomeProfile } from '@phub/home-projection';

const PROFILE_LEVEL_VALUES: Readonly<Record<string, number>> = {
  D: 0,
  'D+': 2.5,
  C: 3,
  'C+': 3.5,
  B: 4.5,
  'B+': 5,
  A: 6,
};

/**
 * `avatarUrl` in `homeProfileSchema` accepts an absolute URL or the PadlHub
 * profile-photo delivery path. A locally stored photo reference is only
 * published when it satisfies that contract; anything else is omitted rather
 * than forwarded as an unverifiable value.
 */
const AVATAR_URL_PATTERN =
  /^(https?:\/\/.+|\/public\/api\/v1\/media\/profile-photos\/[0-9a-f-]{36}\/[0-9a-f-]{36})$/;

export interface LocalHomeProfileInput {
  readonly userId: string;
  readonly displayName: string;
  /** Candidate avatar reference already stabilized through the media repository. */
  readonly avatarUrl?: unknown;
  readonly levelLabel?: string | null;
  readonly levelValue?: number | null;
}

export interface LocalProfileLevel {
  readonly label: string;
  readonly value: number;
  readonly assessmentRequired: boolean;
}

/**
 * Reports a level only when the locally stored summary actually carries one.
 * An empty summary must not be promoted to a synthetic `D`/`0` level: absence is
 * expressed by omitting the field so the client renders a placeholder.
 */
export function localProfileLevel(
  levelLabel: string | null | undefined,
  levelValue: number | null | undefined,
): LocalProfileLevel | undefined {
  const label = levelLabel?.trim();
  if (!label) return undefined;
  const value = levelValue ?? PROFILE_LEVEL_VALUES[label];
  if (value === undefined || !Number.isFinite(value) || value < 0 || value > 10) return undefined;
  return { label, value, assessmentRequired: false };
}

function localAvatarUrl(candidate: unknown): string | undefined {
  return typeof candidate === 'string' && AVATAR_URL_PATTERN.test(candidate)
    ? candidate
    : undefined;
}

function nameParts(displayName: string): {
  readonly firstName: string;
  readonly lastName: string | null;
} {
  const [firstName, ...lastName] = displayName.trim().split(/\s+/);
  return { firstName: firstName || displayName, lastName: lastName.join(' ') || null };
}

/**
 * Builds the locally available slice of the Home profile when the complete
 * dashboard projection does not exist. Only observable, PadlHub-owned values
 * are published: provider-owned money fields and an unassessed level are
 * omitted instead of being filled with `0`, `RUB` or a synthetic level.
 */
export function buildLocalHomeProfile(input: LocalHomeProfileInput): HomeProfile {
  const displayName = input.displayName.trim() || input.displayName;
  const names = nameParts(displayName);
  const avatarUrl = localAvatarUrl(input.avatarUrl);
  const level = localProfileLevel(input.levelLabel, input.levelValue);
  return {
    userId: input.userId,
    displayName,
    firstName: names.firstName,
    lastName: names.lastName,
    ...(avatarUrl === undefined ? {} : { avatarUrl }),
    ...(level === undefined ? {} : { level }),
  };
}
