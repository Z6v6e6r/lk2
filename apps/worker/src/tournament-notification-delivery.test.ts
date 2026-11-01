import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  runTournamentDelivery,
  tournamentProviderResult,
  type TournamentTransport,
} from './tournament-notification-delivery.js';
import { resolveNotificationIntentState } from './notification-delivery-finalizer.js';
import type { TournamentMessageNotificationRepository } from '@phub/database/tournament-message-notifications';
import type { TournamentNotificationOwnerClient } from './tournament-chat-notification-owner.js';
import { fcmRolloutClaimAllowed } from './fcm-rollout-gate.js';
vi.mock('./fcm-rollout-gate.js', () => ({ fcmRolloutClaimAllowed: vi.fn(() => true) }));
afterEach(() => vi.mocked(fcmRolloutClaimAllowed).mockReturnValue(true));
describe('tournament transport safety', () => {
  it.each(['held', 'partial'])(
    'does not claim or attempt FCM when rollout gate is %s',
    async () => {
      vi.mocked(fcmRolloutClaimAllowed).mockReturnValue(false);
      const tx = vi.fn();
      expect(
        await runTournamentDelivery(
          { tx } as unknown as TournamentMessageNotificationRepository,
          {} as TournamentNotificationOwnerClient,
          'tenant',
          { provider: 'FCM' } as TournamentTransport,
        ),
      ).toBe(false);
      expect(tx).not.toHaveBeenCalled();
    },
  );
  it('claims only after the gate releases', async () => {
    const tx = vi.fn().mockResolvedValue(null);
    expect(
      await runTournamentDelivery(
        { tx } as unknown as TournamentMessageNotificationRepository,
        {} as TournamentNotificationOwnerClient,
        'tenant',
        { provider: 'FCM' } as TournamentTransport,
      ),
    ).toBe(false);
    expect(tx).toHaveBeenCalledOnce();
  });
  it.each(['FCM_NETWORK_FAILURE', 'WEB_PUSH_NETWORK_FAILURE', 'PROVIDER_TIMEOUT', 'UNKNOWN'])(
    'never retries ambiguous %s',
    (errorCode) => {
      expect(tournamentProviderResult({ outcome: 'retryable_failure', errorCode })).toEqual({
        outcome: 'terminal_failure',
        errorCode: 'TOURNAMENT_PROVIDER_OUTCOME_UNKNOWN',
        invalidate: false,
      });
    },
  );
  it.each([
    'STATION_NOT_SUBMITTED',
    'FCM_CIRCUIT_OPEN',
    'APNS_AUTH_REJECTED',
    'WEB_PUSH_AUTH_REJECTED',
  ])('allows only proven non-submission retry %s', (errorCode) => {
    expect(tournamentProviderResult({ outcome: 'retryable_failure', errorCode })).toEqual({
      outcome: 'retryable_failure',
      errorCode,
    });
  });
  it.each(['TOURNAMENT_PENDING', 'TOURNAMENT_SENDING'])(
    'keeps aggregate processing for %s',
    (state) => {
      expect(resolveNotificationIntentState(['DELIVERED', state])).toEqual({
        state: 'PROCESSING',
        completed: false,
      });
    },
  );
});
