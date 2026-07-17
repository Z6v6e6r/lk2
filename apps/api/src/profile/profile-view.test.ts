import { describe, expect, it } from 'vitest';

import {
  buildPlayerProfileView,
  DIRECT_CHAT_PERMISSION,
  PROFILE_CONTACT_PERMISSION,
  PROFILE_EXTENDED_READ_PERMISSION,
} from './profile-view.js';

const source = {
  userId: '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca',
  displayName: 'Анна Петрова',
  firstName: 'Анна',
  avatarUrl: null,
  phoneLast4: '4567',
  balanceMinor: 54_000,
  currency: 'RUB',
  level: { label: 'C+', value: 3.8, assessmentRequired: false },
};

describe('player profile view policy', () => {
  it('keeps account data only in the self view', () => {
    const view = buildPlayerProfileView({
      profile: source,
      viewerUserId: source.userId,
      permissions: ['profile.read'],
    });

    expect(view).toMatchObject({
      privateAccount: { phoneLast4: '4567', balanceMinor: 54_000, currency: 'RUB' },
      access: {
        audience: 'SELF',
        tier: 'SELF',
        contact: { status: 'HIDDEN', reason: 'SELF_PROFILE' },
        chat: { status: 'HIDDEN', reason: 'SELF_PROFILE' },
      },
    });
    expect(view.profile.level.value).toBe(3.8);
  });

  it('returns a minimal view and stable lock reasons to a basic viewer', () => {
    const view = buildPlayerProfileView({
      profile: source,
      viewerUserId: '6a81e965-c508-4321-812c-4be323606a70',
      permissions: ['profile.read'],
    });

    expect(view).not.toHaveProperty('privateAccount');
    expect(view.profile.level).toEqual({ label: 'C+', assessmentRequired: false });
    expect(view.access).toMatchObject({
      audience: 'OTHER',
      tier: 'BASIC',
      visibleSections: ['BASIC', 'PLAYER_LEVEL'],
      contact: { status: 'LOCKED', reason: 'ACCESS_REQUIRED' },
      chat: { status: 'LOCKED', reason: 'ACCESS_REQUIRED' },
    });
    expect(JSON.stringify(view)).not.toContain('4567');
    expect(JSON.stringify(view)).not.toContain('54000');
  });

  it('enables only actions explicitly granted by server permissions', () => {
    const view = buildPlayerProfileView({
      profile: source,
      viewerUserId: '6a81e965-c508-4321-812c-4be323606a70',
      permissions: [
        'profile.read',
        PROFILE_EXTENDED_READ_PERMISSION,
        PROFILE_CONTACT_PERMISSION,
        DIRECT_CHAT_PERMISSION,
      ],
    });

    expect(view.profile.level.value).toBe(3.8);
    expect(view.access.tier).toBe('INTERACTION');
    expect(view.access.contact).toEqual({
      status: 'AVAILABLE',
      route: `/chats/new?participantId=${source.userId}&intent=contact`,
    });
    expect(view.access.chat).toEqual({
      status: 'AVAILABLE',
      route: `/chats/new?participantId=${source.userId}`,
    });
  });

  it('lets the target privacy policy override a viewer permission', () => {
    const view = buildPlayerProfileView({
      profile: source,
      viewerUserId: '6a81e965-c508-4321-812c-4be323606a70',
      permissions: [PROFILE_CONTACT_PERMISSION, DIRECT_CHAT_PERMISSION],
      policy: { contactPolicy: 'NOBODY', chatPolicy: 'NOBODY' },
    });

    expect(view.access.contact).toEqual({
      status: 'LOCKED',
      reason: 'PROFILE_RESTRICTED',
    });
    expect(view.access.chat).toEqual({ status: 'LOCKED', reason: 'PROFILE_RESTRICTED' });
  });
});
