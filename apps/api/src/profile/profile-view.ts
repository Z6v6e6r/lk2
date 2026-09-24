import { DEFAULT_PROFILE_PRIVACY_SETTINGS, type ProfilePrivacySettings } from '@phub/domain';

import type { HomeDashboard } from '../home/home-dashboard-schema.js';

export const PROFILE_EXTENDED_READ_PERMISSION = 'profile.extended.read';
export const PROFILE_CONTACT_PERMISSION = 'profile.contact.request';
export const DIRECT_CHAT_PERMISSION = 'chat.direct.create';

type ProfileSource = HomeDashboard['profile'];
export interface PlayerProfileViewInput {
  readonly profile: ProfileSource;
  readonly viewerUserId: string;
  readonly permissions: readonly string[];
  readonly policy?: Pick<ProfilePrivacySettings, 'contactPolicy' | 'chatPolicy'>;
  readonly directChatEnabled?: boolean;
  /**
   * False for an imported player record that never signed in and has no login path: the owner
   * lands on a different account, so invites and conversations addressed to this row stay unseen.
   */
  readonly reachable?: boolean;
}

export interface ProfileActionCapability {
  readonly status: 'AVAILABLE' | 'LOCKED' | 'HIDDEN';
  readonly reason?:
    | 'ACCESS_REQUIRED'
    | 'PROFILE_RESTRICTED'
    | 'SELF_PROFILE'
    | 'FEATURE_UNAVAILABLE'
    | 'TARGET_UNREACHABLE';
  readonly route?: string;
}

export interface PlayerProfileView {
  readonly profile: {
    readonly userId: string;
    readonly displayName: string;
    readonly firstName?: string | null;
    readonly lastName?: string | null;
    readonly avatarUrl?: string | null;
    /** Omitted when no stored assessment exists; the client renders a placeholder. */
    readonly level?: {
      readonly label: string;
      readonly assessmentRequired: boolean;
      readonly value?: number;
    };
  };
  readonly privateAccount?: {
    readonly phoneLast4?: string;
    /** Omitted when the local read cannot observe the provider balance. */
    readonly balanceMinor?: number;
    readonly currency?: string;
  };
  /** Always true for the viewer's own profile. */
  readonly reachable: boolean;
  readonly access: {
    readonly audience: 'SELF' | 'OTHER';
    readonly tier: 'BASIC' | 'EXTENDED' | 'INTERACTION' | 'SELF';
    readonly visibleSections: readonly (
      'BASIC' | 'PLAYER_LEVEL' | 'PLAYER_RATING' | 'PRIVATE_ACCOUNT'
    )[];
    readonly contact: ProfileActionCapability;
    readonly chat: ProfileActionCapability;
  };
}

function selfAction(): ProfileActionCapability {
  return { status: 'HIDDEN', reason: 'SELF_PROFILE' };
}

function otherAction(
  granted: boolean,
  policy: ProfilePrivacySettings['contactPolicy'],
  unavailablePresentation: 'LOCKED' | 'HIDDEN',
  reachable: boolean,
): ProfileActionCapability {
  if (!reachable) return { status: 'LOCKED', reason: 'TARGET_UNREACHABLE' };
  if (policy === 'NOBODY') return { status: 'LOCKED', reason: 'PROFILE_RESTRICTED' };
  if (!granted) return { status: 'LOCKED', reason: 'ACCESS_REQUIRED' };
  // Authorization and target privacy are necessary but not sufficient to
  // publish an interaction. Until the direct-conversation command is mounted
  // in the current release, keep the capability out of the rendered UI rather
  // than advertising a dead `/chats/new` route.
  return unavailablePresentation === 'HIDDEN'
    ? { status: 'HIDDEN' }
    : { status: 'LOCKED', reason: 'FEATURE_UNAVAILABLE' };
}

function chatAction(input: {
  readonly granted: boolean;
  readonly policy: ProfilePrivacySettings['chatPolicy'];
  readonly enabled: boolean;
  readonly reachable: boolean;
  readonly targetUserId: string;
}): ProfileActionCapability {
  if (!input.reachable) return { status: 'LOCKED', reason: 'TARGET_UNREACHABLE' };
  if (input.policy === 'NOBODY') return { status: 'LOCKED', reason: 'PROFILE_RESTRICTED' };
  if (!input.granted) return { status: 'LOCKED', reason: 'ACCESS_REQUIRED' };
  if (!input.enabled) return { status: 'HIDDEN' };
  // `open=1` asks the chats screen to run the create command on arrival instead of showing the
  // intermediate "Новый личный чат" confirmation: the button already says what it does.
  return {
    status: 'AVAILABLE',
    route: `/chats/new?recipientUserId=${encodeURIComponent(input.targetUserId)}&open=1`,
  };
}

/**
 * Builds the only DTO allowed to cross the player-profile boundary. The
 * caller supplies server-derived permissions; the browser never receives a
 * complete profile and then decides which fields to hide.
 */
export function buildPlayerProfileView(input: PlayerProfileViewInput): PlayerProfileView {
  const isSelf = input.viewerUserId === input.profile.userId;
  const reachable = isSelf || input.reachable !== false;
  const policy = input.policy ?? DEFAULT_PROFILE_PRIVACY_SETTINGS;
  const canReadExtended = isSelf || input.permissions.includes(PROFILE_EXTENDED_READ_PERMISSION);
  const canContact = input.permissions.includes(PROFILE_CONTACT_PERMISSION);
  const canChat = input.permissions.includes(DIRECT_CHAT_PERMISSION);
  const hasInteractionAccess = canContact || canChat;

  const visibleSections: PlayerProfileView['access']['visibleSections'] = [
    'BASIC',
    'PLAYER_LEVEL',
    ...(canReadExtended ? (['PLAYER_RATING'] as const) : []),
    ...(isSelf ? (['PRIVATE_ACCOUNT'] as const) : []),
  ];

  const profile = {
    userId: input.profile.userId,
    displayName: input.profile.displayName,
    ...(input.profile.firstName !== undefined ? { firstName: input.profile.firstName } : {}),
    ...(input.profile.lastName !== undefined ? { lastName: input.profile.lastName } : {}),
    ...(input.profile.avatarUrl !== undefined ? { avatarUrl: input.profile.avatarUrl } : {}),
    ...(input.profile.level !== undefined
      ? {
          level: {
            label: input.profile.level.label,
            assessmentRequired: input.profile.level.assessmentRequired,
            ...(canReadExtended ? { value: input.profile.level.value } : {}),
          },
        }
      : {}),
  };

  return {
    profile,
    reachable,
    ...(isSelf
      ? {
          privateAccount: {
            ...(input.profile.phoneLast4 ? { phoneLast4: input.profile.phoneLast4 } : {}),
            ...(input.profile.balanceMinor === undefined
              ? {}
              : { balanceMinor: input.profile.balanceMinor }),
            ...(input.profile.currency === undefined ? {} : { currency: input.profile.currency }),
          },
        }
      : {}),
    access: {
      audience: isSelf ? 'SELF' : 'OTHER',
      tier: isSelf
        ? 'SELF'
        : hasInteractionAccess
          ? 'INTERACTION'
          : canReadExtended
            ? 'EXTENDED'
            : 'BASIC',
      visibleSections,
      contact: isSelf
        ? selfAction()
        : otherAction(canContact, policy.contactPolicy, 'LOCKED', reachable),
      chat: isSelf
        ? selfAction()
        : chatAction({
            granted: canChat,
            policy: policy.chatPolicy,
            enabled: input.directChatEnabled ?? false,
            reachable,
            targetUserId: input.profile.userId,
          }),
    },
  };
}
