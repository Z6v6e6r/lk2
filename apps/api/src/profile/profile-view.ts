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
}

export interface ProfileActionCapability {
  readonly status: 'AVAILABLE' | 'LOCKED' | 'HIDDEN';
  readonly reason?: 'ACCESS_REQUIRED' | 'PROFILE_RESTRICTED' | 'SELF_PROFILE';
  readonly route?: string;
}

export interface PlayerProfileView {
  readonly profile: {
    readonly userId: string;
    readonly displayName: string;
    readonly firstName?: string | null;
    readonly avatarUrl?: string | null;
    readonly level: {
      readonly label: string;
      readonly assessmentRequired: boolean;
      readonly value?: number;
    };
  };
  readonly privateAccount?: {
    readonly phoneLast4?: string;
    readonly balanceMinor: number;
    readonly currency: string;
  };
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
  route: string,
): ProfileActionCapability {
  if (policy === 'NOBODY') return { status: 'LOCKED', reason: 'PROFILE_RESTRICTED' };
  if (!granted) return { status: 'LOCKED', reason: 'ACCESS_REQUIRED' };
  return { status: 'AVAILABLE', route };
}

/**
 * Builds the only DTO allowed to cross the player-profile boundary. The
 * caller supplies server-derived permissions; the browser never receives a
 * complete profile and then decides which fields to hide.
 */
export function buildPlayerProfileView(input: PlayerProfileViewInput): PlayerProfileView {
  const isSelf = input.viewerUserId === input.profile.userId;
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
    ...(input.profile.avatarUrl !== undefined ? { avatarUrl: input.profile.avatarUrl } : {}),
    level: {
      label: input.profile.level.label,
      assessmentRequired: input.profile.level.assessmentRequired,
      ...(canReadExtended ? { value: input.profile.level.value } : {}),
    },
  };

  return {
    profile,
    ...(isSelf
      ? {
          privateAccount: {
            ...(input.profile.phoneLast4 ? { phoneLast4: input.profile.phoneLast4 } : {}),
            balanceMinor: input.profile.balanceMinor,
            currency: input.profile.currency,
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
        : otherAction(
            canContact,
            policy.contactPolicy,
            `/chats/new?participantId=${input.profile.userId}&intent=contact`,
          ),
      chat: isSelf
        ? selfAction()
        : otherAction(
            canChat,
            policy.chatPolicy,
            `/chats/new?participantId=${input.profile.userId}`,
          ),
    },
  };
}
