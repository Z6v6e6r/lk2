// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LevelEligibilityWorkspace } from './LevelEligibilityWorkspace.js';
import type {
  LevelEligibilityActivityType,
  LevelEligibilityPolicyAdminView,
  NotificationAdminClient,
} from './notification-admin-client.js';

afterEach(cleanup);

const levels = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    sportCode: 'PADEL',
    code: 'C',
    title: 'C',
    rank: 3,
    sortOrder: 3,
    aliases: ['C'],
    active: true,
    scaleVersion: 1,
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    sportCode: 'PADEL',
    code: 'B',
    title: 'B',
    rank: 5,
    sortOrder: 5,
    aliases: ['B'],
    active: true,
    scaleVersion: 1,
  },
] as const;
const readiness = [
  {
    activityType: 'GAME' as const,
    writerAuthoritative: true,
    playerProjectionReady: false,
    clientRecoveryReady: true,
    paymentRecoveryReady: true,
    readyForBlock: false,
    missingGates: ['player_projection_ready'],
    verifiedAt: null,
  },
] as const;

function policy(activityType: LevelEligibilityActivityType): LevelEligibilityPolicyAdminView {
  return {
    id:
      `${activityType === 'GAME' ? '3' : activityType === 'TOURNAMENT' ? '4' : '5'}`.repeat(8) +
      '-3333-4333-8333-333333333333',
    sportCode: 'PADEL',
    activityType,
    mode: 'OFF',
    lowerToleranceSteps: 0,
    upperToleranceSteps: 0,
    missingActivityConstraintAction: 'ALLOW',
    legacyTextConstraintAction: 'ALLOW',
    recheckWaitlistPromotion: true,
    version: 1,
    changeComment: 'Safe initial policy',
    updatedBy: null,
    createdAt: '2026-08-16T10:00:00.000Z',
  };
}

describe('LevelEligibilityWorkspace', () => {
  it('requires an explicit commented publish and shows immutable system exceptions', async () => {
    const policies = [policy('GAME'), policy('TOURNAMENT'), policy('TRAINING')];
    const publishLevelEligibilityPolicy = vi.fn().mockResolvedValue({
      policy: { ...policies[0], mode: 'SHADOW', version: 2 },
      replayed: false,
    });
    const client = {
      getLevelEligibilityState: vi
        .fn()
        .mockResolvedValue({ sportCode: 'PADEL', levels, policies, readiness }),
      getLevelEligibilityImpact: vi.fn().mockResolvedValue({ items: [] }),
      getLevelEligibilityHistory: vi.fn().mockResolvedValue({ items: policies }),
      publishLevelEligibilityPolicy,
      rollbackLevelEligibilityPolicy: vi.fn(),
      previewLevelEligibility: vi.fn(),
    } as unknown as NotificationAdminClient;
    render(<LevelEligibilityWorkspace client={client} />);

    expect(
      await screen.findByText('Персональное приглашение обходит только ограничение уровня.'),
    ).toBeInTheDocument();
    expect(screen.getByText(/player_projection_ready/)).toBeInTheDocument();
    const games = screen.getByRole('heading', { name: 'Игры' }).closest('section');
    expect(games).not.toBeNull();
    const controls = within(games!);
    expect(
      controls.getByLabelText('Повторная проверка при продвижении обязательна'),
    ).toBeDisabled();
    const publish = controls.getByRole('button', { name: 'Опубликовать настройки' });
    expect(publish).toBeDisabled();
    fireEvent.change(controls.getByLabelText('Режим'), { target: { value: 'SHADOW' } });
    fireEvent.change(controls.getByLabelText('Комментарий к публикации'), {
      target: { value: 'Shadow для проверки данных' },
    });
    fireEvent.click(publish);

    await waitFor(() =>
      expect(publishLevelEligibilityPolicy).toHaveBeenCalledWith(
        'GAME',
        expect.objectContaining({
          expectedVersion: 1,
          mode: 'SHADOW',
          changeComment: 'Shadow для проверки данных',
        }),
      ),
    );
  });
});
