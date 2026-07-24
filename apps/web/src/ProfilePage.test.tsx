// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import type { PlayerProfileView } from '@phub/api-sdk';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { ProfilePage } from './ProfilePage.js';

afterEach(cleanup);

function selfProfile(level: string): PlayerProfileView {
  return {
    profile: {
      userId: '14f15c0a-b6b6-4701-86a6-0c789c81a815',
      displayName: 'Алексей Максимов',
      avatarUrl: null,
      level: { label: level, value: 3.64, assessmentRequired: false },
    },
    privateAccount: { phoneLast4: '5826', balanceMinor: 54000, currency: 'RUB' },
    access: {
      audience: 'SELF',
      tier: 'SELF',
      visibleSections: ['BASIC', 'PLAYER_LEVEL', 'PLAYER_RATING', 'PRIVATE_ACCOUNT'],
      contact: { status: 'HIDDEN', reason: 'SELF_PROFILE' },
      chat: { status: 'HIDDEN', reason: 'SELF_PROFILE' },
    },
  };
}

describe('ProfilePage', () => {
  it.each([
    ['A', 'level-a.jpg'],
    ['B+', 'level-b-plus.jpg'],
    ['B', 'level-b.jpg'],
    ['C+', 'level-c-plus.jpg'],
    ['C', 'level-c.jpg'],
    ['D+', 'level-d-plus.jpg'],
    ['D', 'level-d.jpg'],
  ])('uses the supplied %s level artwork', (level, filename) => {
    render(
      <ProfilePage
        profile={selfProfile(level)}
        tenantName="ПаделХАБ"
        logoutBusy={false}
        communities={{ items: [] }}
        onLogout={() => undefined}
      />,
    );

    expect(screen.getByRole('main').getAttribute('style')).toContain(filename);
    expect(
      screen.getByRole('img', {
        name: `Алексей Максимов, уровень ${level}, прогресс 64%`,
      }),
    ).toBeVisible();
  });
});
