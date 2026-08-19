import { createHash } from 'node:crypto';

import {
  assertEligibilityPaymentAclMatrixBinding,
  assertEligibilityPaymentCupProjectionAclMatrixBinding,
} from './eligibility-payment-acl-matrix.js';

export const COMMUNITIES_STAGED_REHEARSAL_CONFIRMATION = 'COMMUNITIES_STAGED_REHEARSAL_29_V1';
export const COMMUNITIES_STAGED_REHEARSAL_32_CONFIRMATION = 'COMMUNITIES_STAGED_REHEARSAL_32_V1';
export const COMMUNITIES_STAGED_REHEARSAL_33_CONFIRMATION = 'COMMUNITIES_STAGED_REHEARSAL_33_V1';

export const COMMUNITIES_STAGED_REHEARSAL_PHASES = [
  'pre_foundation',
  'foundation',
  'post_foundation',
] as const;

export const COMMUNITIES_STAGED_REHEARSAL_32_PHASES = [
  ...COMMUNITIES_STAGED_REHEARSAL_PHASES,
  'eligibility_payment',
] as const;

export const COMMUNITIES_STAGED_REHEARSAL_33_PHASES = [
  ...COMMUNITIES_STAGED_REHEARSAL_32_PHASES,
  'cup_projection',
] as const;

export type CommunitiesStagedRehearsalPhase =
  (typeof COMMUNITIES_STAGED_REHEARSAL_33_PHASES)[number];
export type CommunitiesStagedRehearsalContractVersion = '29_V1' | '32_V1' | '33_V1';

export const COMMUNITIES_STAGED_REHEARSAL_PRE_FOUNDATION_FILENAMES = [
  '0053_profile_visibility_sections.sql',
  '0054_community_membership_pin_commands.sql',
  '0055_community_create_commands.sql',
  '0056_community_discovery_indexes.sql',
  '0057_community_membership_lifecycle.sql',
  '0058_community_direct_invites.sql',
  '0059_community_direct_invite_quotas.sql',
  '0060_viva_home_booking_ownership.sql',
  '0061_community_mine_keyset_index.sql',
  '0062_community_ownership_transfers.sql',
  '0063_community_content_foundation.sql',
  '0064_community_durable_events.sql',
  '0065_community_content_moderation.sql',
  '0066_community_member_count_projection.sql',
  '0067_community_media_lifecycle.sql',
  '0068_community_event_retention.sql',
] as const;

export const COMMUNITIES_STAGED_REHEARSAL_FOUNDATION_FILENAMES = [
  '0069_booking_notification_projection_fence.sql',
  '0070_web_push_endpoint_hardening.sql',
  '0071_messaging_user_blocks.sql',
  '0072_web_push_endpoint_status_validation.sql',
  '0073_booking_reminder_scheduler.sql',
] as const;

export const COMMUNITIES_STAGED_REHEARSAL_POST_FOUNDATION_FILENAMES = [
  '0076_community_create_quota_grants.sql',
  '0077_community_media_operational_recovery.sql',
  '0078_community_media_issue_quotas.sql',
  '0079_profile_photo_client_assisted_source.sql',
  '0080_community_logo_stable_delivery.sql',
  '0081_community_logo_stable_delivery_validate.sql',
  '0082_profile_photo_removal_commands.sql',
  '0083_profile_photo_removal_commands_validate.sql',
] as const;

export const COMMUNITIES_STAGED_REHEARSAL_PENDING_FILENAMES = [
  ...COMMUNITIES_STAGED_REHEARSAL_PRE_FOUNDATION_FILENAMES,
  ...COMMUNITIES_STAGED_REHEARSAL_FOUNDATION_FILENAMES,
  ...COMMUNITIES_STAGED_REHEARSAL_POST_FOUNDATION_FILENAMES,
] as const;

export const COMMUNITIES_STAGED_REHEARSAL_ELIGIBILITY_PAYMENT_FILENAMES = [
  '0084_participation_level_eligibility.sql',
  '0085_game_payment_confirmation_evidence.sql',
  '0086_game_payment_provider_exercise_binding.sql',
] as const;

export const COMMUNITIES_STAGED_REHEARSAL_32_PENDING_FILENAMES = [
  ...COMMUNITIES_STAGED_REHEARSAL_PENDING_FILENAMES,
  ...COMMUNITIES_STAGED_REHEARSAL_ELIGIBILITY_PAYMENT_FILENAMES,
] as const;

export const COMMUNITIES_STAGED_REHEARSAL_CUP_PROJECTION_FILENAMES = [
  '0087_cup_player_level_projection.sql',
] as const;

export const COMMUNITIES_STAGED_REHEARSAL_33_PENDING_FILENAMES = [
  ...COMMUNITIES_STAGED_REHEARSAL_32_PENDING_FILENAMES,
  ...COMMUNITIES_STAGED_REHEARSAL_CUP_PROJECTION_FILENAMES,
] as const;

/** A phase binding commits to the contract version and this ordered filename digest. */
export function communitiesStagedRehearsalPendingSetSha256(filenames: readonly string[]): string {
  return createHash('sha256')
    .update(`${filenames.join('\n')}\n`)
    .digest('hex');
}

export interface CommunitiesStagedRehearsalRequest {
  readonly contractVersion: CommunitiesStagedRehearsalContractVersion;
  readonly phase: CommunitiesStagedRehearsalPhase;
  readonly restoreDatabase: string;
  readonly aclMatrixVersion: string | null;
  readonly aclMatrixSha256: string | null;
}

function fail(code: string): never {
  throw new Error(`COMMUNITIES_STAGED_REHEARSAL_${code}`);
}

function exactOrderedDifference(
  packagedFilenames: readonly string[],
  appliedFilenames: ReadonlySet<string>,
): string[] {
  return packagedFilenames.filter((filename) => !appliedFilenames.has(filename));
}

function sameOrderedValues(actual: readonly string[], expected: readonly string[]): boolean {
  return (
    actual.length === expected.length && actual.every((value, index) => value === expected[index])
  );
}

export function resolveCommunitiesStagedRehearsalRequest(input: {
  readonly confirmation?: string;
  readonly phase?: string;
  readonly restoreDatabase?: string;
  readonly connectionString: string;
  readonly aclMatrixVersion?: string;
  readonly aclMatrixSha256?: string;
}): CommunitiesStagedRehearsalRequest | null {
  const requested = input.confirmation !== undefined || input.phase !== undefined;
  if (!requested) return null;

  if (input.confirmation === COMMUNITIES_STAGED_REHEARSAL_32_CONFIRMATION) {
    fail('32_ACL_MATRIX_REQUIRED');
  }
  const contractVersion =
    input.confirmation === COMMUNITIES_STAGED_REHEARSAL_CONFIRMATION
      ? '29_V1'
      : input.confirmation === COMMUNITIES_STAGED_REHEARSAL_33_CONFIRMATION
        ? '33_V1'
        : null;
  if (!contractVersion) {
    fail('CONFIRMATION_REQUIRED');
  }
  if (
    !input.phase ||
    !(
      contractVersion === '29_V1'
        ? COMMUNITIES_STAGED_REHEARSAL_PHASES
        : COMMUNITIES_STAGED_REHEARSAL_33_PHASES
    ).includes(input.phase as never)
  ) {
    fail('PHASE_INVALID');
  }
  if (!input.restoreDatabase || !/^phub_restore_[0-9]+(?:_[0-9]+)+$/.test(input.restoreDatabase)) {
    fail('DATABASE_INVALID');
  }

  let connection: URL;
  try {
    connection = new URL(input.connectionString);
  } catch {
    fail('DATABASE_URL_INVALID');
  }
  if (
    !['postgres:', 'postgresql:'].includes(connection.protocol) ||
    connection.hostname !== 'postgres' ||
    (connection.port || '5432') !== '5432' ||
    connection.search ||
    connection.hash
  ) {
    fail('DATABASE_TARGET_INVALID');
  }

  let connectionDatabase: string;
  try {
    connectionDatabase = decodeURIComponent(connection.pathname.replace(/^\//, ''));
  } catch {
    fail('DATABASE_URL_INVALID');
  }
  if (connectionDatabase !== input.restoreDatabase) fail('DATABASE_TARGET_MISMATCH');

  return {
    contractVersion,
    phase: input.phase as CommunitiesStagedRehearsalPhase,
    restoreDatabase: input.restoreDatabase,
    aclMatrixVersion: contractVersion === '33_V1' ? (input.aclMatrixVersion ?? null) : null,
    aclMatrixSha256: contractVersion === '33_V1' ? (input.aclMatrixSha256 ?? null) : null,
  };
}

export function selectCommunitiesStagedRehearsalMigrations(input: {
  readonly request: CommunitiesStagedRehearsalRequest;
  readonly appliedFilenames: ReadonlySet<string>;
  readonly packagedFilenames: readonly string[];
}): readonly string[] {
  if (input.request.contractVersion === '29_V1') {
    if (input.request.aclMatrixVersion !== null || input.request.aclMatrixSha256 !== null) {
      fail('ACL_MATRIX_UNEXPECTED');
    }
  } else if (input.request.contractVersion === '32_V1') {
    try {
      assertEligibilityPaymentAclMatrixBinding({
        version: input.request.aclMatrixVersion ?? '',
        sha256: input.request.aclMatrixSha256 ?? '',
      });
    } catch {
      fail('ACL_MATRIX_BINDING_INVALID');
    }
  } else {
    try {
      assertEligibilityPaymentCupProjectionAclMatrixBinding({
        version: input.request.aclMatrixVersion ?? '',
        sha256: input.request.aclMatrixSha256 ?? '',
      });
    } catch {
      fail('ACL_MATRIX_BINDING_INVALID');
    }
  }
  const plan =
    input.request.contractVersion === '29_V1'
      ? {
          phases: COMMUNITIES_STAGED_REHEARSAL_PHASES,
          pending: COMMUNITIES_STAGED_REHEARSAL_PENDING_FILENAMES,
        }
      : input.request.contractVersion === '32_V1'
        ? {
            phases: COMMUNITIES_STAGED_REHEARSAL_32_PHASES,
            pending: COMMUNITIES_STAGED_REHEARSAL_32_PENDING_FILENAMES,
          }
        : {
            phases: COMMUNITIES_STAGED_REHEARSAL_33_PHASES,
            pending: COMMUNITIES_STAGED_REHEARSAL_33_PENDING_FILENAMES,
          };
  const phaseFilenames =
    input.request.phase === 'pre_foundation'
      ? COMMUNITIES_STAGED_REHEARSAL_PRE_FOUNDATION_FILENAMES
      : input.request.phase === 'foundation'
        ? COMMUNITIES_STAGED_REHEARSAL_FOUNDATION_FILENAMES
        : input.request.phase === 'post_foundation'
          ? COMMUNITIES_STAGED_REHEARSAL_POST_FOUNDATION_FILENAMES
          : input.request.phase === 'eligibility_payment'
            ? COMMUNITIES_STAGED_REHEARSAL_ELIGIBILITY_PAYMENT_FILENAMES
            : COMMUNITIES_STAGED_REHEARSAL_CUP_PROJECTION_FILENAMES;
  const expectedPending =
    input.request.phase === 'pre_foundation'
      ? plan.pending
      : input.request.phase === 'foundation'
        ? input.request.contractVersion === '29_V1'
          ? [
              ...COMMUNITIES_STAGED_REHEARSAL_FOUNDATION_FILENAMES,
              ...COMMUNITIES_STAGED_REHEARSAL_POST_FOUNDATION_FILENAMES,
            ]
          : input.request.contractVersion === '32_V1'
            ? [
                ...COMMUNITIES_STAGED_REHEARSAL_FOUNDATION_FILENAMES,
                ...COMMUNITIES_STAGED_REHEARSAL_POST_FOUNDATION_FILENAMES,
                ...COMMUNITIES_STAGED_REHEARSAL_ELIGIBILITY_PAYMENT_FILENAMES,
              ]
            : [
                ...COMMUNITIES_STAGED_REHEARSAL_FOUNDATION_FILENAMES,
                ...COMMUNITIES_STAGED_REHEARSAL_POST_FOUNDATION_FILENAMES,
                ...COMMUNITIES_STAGED_REHEARSAL_ELIGIBILITY_PAYMENT_FILENAMES,
                ...COMMUNITIES_STAGED_REHEARSAL_CUP_PROJECTION_FILENAMES,
              ]
        : input.request.phase === 'post_foundation'
          ? input.request.contractVersion === '29_V1'
            ? COMMUNITIES_STAGED_REHEARSAL_POST_FOUNDATION_FILENAMES
            : input.request.contractVersion === '32_V1'
              ? [
                  ...COMMUNITIES_STAGED_REHEARSAL_POST_FOUNDATION_FILENAMES,
                  ...COMMUNITIES_STAGED_REHEARSAL_ELIGIBILITY_PAYMENT_FILENAMES,
                ]
              : [
                  ...COMMUNITIES_STAGED_REHEARSAL_POST_FOUNDATION_FILENAMES,
                  ...COMMUNITIES_STAGED_REHEARSAL_ELIGIBILITY_PAYMENT_FILENAMES,
                  ...COMMUNITIES_STAGED_REHEARSAL_CUP_PROJECTION_FILENAMES,
                ]
          : input.request.phase === 'eligibility_payment'
            ? input.request.contractVersion === '32_V1'
              ? COMMUNITIES_STAGED_REHEARSAL_ELIGIBILITY_PAYMENT_FILENAMES
              : [
                  ...COMMUNITIES_STAGED_REHEARSAL_ELIGIBILITY_PAYMENT_FILENAMES,
                  ...COMMUNITIES_STAGED_REHEARSAL_CUP_PROJECTION_FILENAMES,
                ]
            : COMMUNITIES_STAGED_REHEARSAL_CUP_PROJECTION_FILENAMES;

  if (!(plan.phases as readonly string[]).includes(input.request.phase)) fail('PHASE_INVALID');

  const actualPending = exactOrderedDifference(input.packagedFilenames, input.appliedFilenames);
  if (!sameOrderedValues(actualPending, expectedPending)) {
    fail(`PENDING_SET_MISMATCH:${actualPending.join(',')}`);
  }

  const packaged = new Set(input.packagedFilenames);
  if (phaseFilenames.some((filename) => !packaged.has(filename))) {
    fail('PACKAGED_PLAN_INCOMPLETE');
  }
  return phaseFilenames;
}
