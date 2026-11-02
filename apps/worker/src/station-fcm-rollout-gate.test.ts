import { afterEach, describe, expect, it, vi } from 'vitest';
import { runStationDelivery, type StationTransport } from './station-notification-delivery.js';
import { fcmRolloutClaimAllowed } from './fcm-rollout-gate.js';
import type { StationMessageNotificationRepository } from '@phub/database/station-message-notifications';
import type { StationNotificationClient } from './station-notification-client.js';
vi.mock('./fcm-rollout-gate.js', () => ({ fcmRolloutClaimAllowed: vi.fn(() => true) }));
afterEach(() => vi.clearAllMocks());
function fixture(provider: StationTransport['provider']) {
  const tx = vi.fn().mockResolvedValue(null);
  const eligibility = vi.fn();
  const send = vi.fn();
  return {
    tx,
    eligibility,
    send,
    run: () =>
      runStationDelivery(
        { tx } as unknown as StationMessageNotificationRepository,
        { eligibility } as unknown as StationNotificationClient,
        'synthetic-tenant',
        { provider, adapter: { send } } as unknown as StationTransport,
      ),
  };
}
describe('station FCM rollout gate', () => {
  it.each(['held', 'partial'])('does no claim, attempt, owner read or send while %s', async () => {
    vi.mocked(fcmRolloutClaimAllowed).mockReturnValue(false);
    const f = fixture('FCM');
    expect(await f.run()).toBe(false);
    expect(fcmRolloutClaimAllowed).toHaveBeenCalledOnce();
    expect(f.tx).not.toHaveBeenCalled();
    expect(f.eligibility).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  });
  it('reads the gate again for each cycle and resumes claims after release', async () => {
    vi.mocked(fcmRolloutClaimAllowed).mockReturnValueOnce(false).mockReturnValueOnce(true);
    const f = fixture('FCM');
    await f.run();
    expect(f.tx).not.toHaveBeenCalled();
    await f.run();
    expect(f.tx).toHaveBeenCalledOnce();
    expect(fcmRolloutClaimAllowed).toHaveBeenCalledTimes(2);
  });
  it.each(['APNS', 'WEB_PUSH'] as const)('does not impose the FCM gate on %s', async (provider) => {
    vi.mocked(fcmRolloutClaimAllowed).mockReturnValue(false);
    const f = fixture(provider);
    await f.run();
    expect(fcmRolloutClaimAllowed).not.toHaveBeenCalled();
    expect(f.tx).toHaveBeenCalledOnce();
  });
});
