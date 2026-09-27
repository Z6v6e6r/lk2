import { describe, expect, it, vi } from 'vitest';
import { PadlHubApiClient } from '@phub/api-sdk';
import { createBrowserAuthGateway } from '../../web/src/auth-gateway.js';

const userId = '00000000-0000-4000-8000-000000000001';
const session = {
  accessToken: 'synthetic-process-token',
  tokenType: 'Bearer',
  expiresAt: '2099-09-27T00:00:00Z',
  user: { id: userId, displayName: 'Тестовый игрок' },
  context: {
    userId,
    tenantId: '00000000-0000-4000-8000-000000000002',
    displayName: 'Тестовый игрок',
    phoneLast4: '0001',
    roles: ['client'],
    permissions: ['profile.read'],
  },
};
const options = {
  baseUrl: 'https://lk.nano.padlhub.su',
  tenantKey: 'local-padel',
  platform: 'android' as const,
  appVersion: 'test',
};
const acceptance = {
  publicOfferAccepted: true as const,
  personalDataPolicyAccepted: true as const,
};
function url(input: Parameters<typeof fetch>[0]): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}

describe('Android process session using the existing API contract', () => {
  it('restores without network; OTP then reads the canonical profile with the Android header', async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockImplementation((input) =>
        Promise.resolve(
          Response.json(
            url(input).endsWith('/verify') ? session : { userId, displayName: 'Тестовый игрок' },
          ),
        ),
      );
    const gateway = createBrowserAuthGateway({ ...options, fetchImplementation: transport });
    expect(await gateway.restoreSession()).toBeNull();
    expect(transport).not.toHaveBeenCalled();
    expect(
      (await gateway.verifyCode({ challengeId: 'challenge', code: '0000', acceptance })).context
        .user.id,
    ).toBe(userId);
    await gateway.getSelfProfile();
    expect(transport).toHaveBeenCalledTimes(2);
    const [input, init] = transport.mock.calls[1]!;
    expect(url(input)).toContain('/profile');
    expect(new Headers(init?.headers).get('X-App-Platform')).toBe('android');
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer synthetic-process-token');
    expect(init?.credentials).toBe('omit');
    await gateway.logout();
    await expect(gateway.getSelfProfile()).rejects.toThrow('AUTH_REQUIRED');
    expect(transport).toHaveBeenCalledTimes(2);
  });
  it('never exchanges native credentials for browser-only providers, payments, media or push', async () => {
    const transport = vi.fn<typeof fetch>();
    const gateway = createBrowserAuthGateway({ ...options, fetchImplementation: transport });
    await expect(gateway.startVivaOAuth({ provider: 'yandex', acceptance })).rejects.toThrow();
    await expect(gateway.refreshVivaAccessToken()).rejects.toThrow('DIRECT_VIVA_DISABLED');
    await expect(gateway.listTrainingSchedule()).rejects.toMatchObject({
      code: 'NATIVE_FLOW_UNAVAILABLE',
    });
    await expect(gateway.createPublicGiftCertificatePaymentIntent('order')).rejects.toMatchObject({
      code: 'NATIVE_FLOW_UNAVAILABLE',
    });
    await expect(
      gateway.uploadStationSupportAttachment({
        fileName: 'photo.png',
        contentType: 'image/png',
        data: '',
      }),
    ).rejects.toMatchObject({ code: 'NATIVE_FLOW_UNAVAILABLE' });
    await expect(gateway.listStationSupportStations()).rejects.toMatchObject({
      code: 'NATIVE_FLOW_UNAVAILABLE',
    });
    await expect(gateway.listStationSupportMessages('dialog')).rejects.toMatchObject({
      code: 'NATIVE_FLOW_UNAVAILABLE',
    });
    await expect(
      gateway.sendStationSupportMessage({
        clientMessageId: 'synthetic-command',
        text: 'synthetic',
        stationId: 'station',
      }),
    ).rejects.toMatchObject({ code: 'NATIVE_FLOW_UNAVAILABLE' });
    await expect(gateway.loadStationSupportAttachment('attachment')).rejects.toMatchObject({
      code: 'NATIVE_FLOW_UNAVAILABLE',
    });
    await expect(
      gateway.finalizeCommunityMediaUpload('community', 'media', 1),
    ).rejects.toMatchObject({ code: 'NATIVE_FLOW_UNAVAILABLE' });
    await expect(
      gateway.finalizeConversationMediaUpload('chat', 'media', 1, 'synthetic-command'),
    ).rejects.toMatchObject({ code: 'NATIVE_FLOW_UNAVAILABLE' });
    await expect(gateway.revokeWebPushEndpoint('installation')).rejects.toMatchObject({
      code: 'NATIVE_FLOW_UNAVAILABLE',
    });
    expect(await gateway.getWebPushConfiguration()).toEqual({ enabled: false });
    expect(transport).not.toHaveBeenCalled();
  });
  it('does not retry a 401 or retain an expired token in the SDK', async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json(
          { code: 'AUTH_REQUIRED', message: 'Expired', correlationId: 'test' },
          { status: 401 },
        ),
      );
    const client = new PadlHubApiClient({
      ...options,
      sessionMode: 'memory',
      initialAccessToken: 'synthetic-process-token',
      fetchImplementation: transport,
    });
    await expect(client.getUserProfile()).rejects.toMatchObject({ status: 401 });
    expect(client.getAccessToken()).toBeUndefined();
    expect(transport).toHaveBeenCalledOnce();
    await expect(client.refreshSession()).rejects.toMatchObject({ status: 401 });
    await client.revokeSession();
    expect(transport).toHaveBeenCalledOnce();
  });
});

it('does not let an old in-flight 401 invalidate a later Android session', async () => {
  let resolveOld!: (response: Response) => void;
  const expire = vi.fn();
  const transport = vi.fn<typeof fetch>().mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveOld = resolve;
      }),
  );
  const client = new PadlHubApiClient({
    ...options,
    sessionMode: 'memory',
    onSessionExpired: expire,
    initialAccessToken: 'old-synthetic-token',
    fetchImplementation: transport,
  });
  const oldRequest = client.getUserProfile();
  client.setAccessToken('new-synthetic-token');
  resolveOld(Response.json({ code: 'AUTH_REQUIRED', message: 'Expired' }, { status: 401 }));
  await expect(oldRequest).rejects.toMatchObject({ status: 401 });
  expect(client.getAccessToken()).toBe('new-synthetic-token');
  expect(expire).not.toHaveBeenCalled();
});
