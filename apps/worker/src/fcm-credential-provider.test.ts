import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { FcmServiceAccountTokenProvider } from './fcm-credential-provider.js';

const key = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString();
function filesystem(body: string, mode = 0o100600) {
  return {
    lstat: vi.fn().mockResolvedValue({
      isFile: () => true,
      isSymbolicLink: () => false,
      mode,
      uid: process.getuid?.() ?? 0,
    }),
    realpath: vi.fn().mockResolvedValue('/run/secrets/fcm.json'),
    readFile: vi.fn().mockResolvedValue(body),
  };
}
function credential(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: 'service_account',
    project_id: 'padlhub',
    client_email: 'worker@padlhub.iam.gserviceaccount.com',
    private_key: key,
    token_uri: 'https://oauth2.googleapis.com/token',
    ...overrides,
  });
}
describe('FCM service-account credential provider', () => {
  it('uses an injected secure file and caches a bounded OAuth token', async () => {
    let now = 1_000_000;
    const fetchImplementation = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ access_token: 'opaque-token', expires_in: 600 }), {
          status: 200,
        }),
      ),
    );
    const provider = await FcmServiceAccountTokenProvider.create({
      credentialFile: '/run/secrets/fcm.json',
      projectId: 'padlhub',
      filesystem: filesystem(credential()),
      fetchImplementation,
      now: () => now,
    });
    await expect(provider.getAccessToken()).resolves.toBe('opaque-token');
    await expect(provider.getAccessToken()).resolves.toBe('opaque-token');
    expect(fetchImplementation).toHaveBeenCalledOnce();
    expect(fetchImplementation).toHaveBeenCalledOnce();
    now += 600_000;
    await provider.getAccessToken();
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });
  it('coalesces concurrent refreshes into one OAuth request', async () => {
    let resolveFetch: ((response: Response) => void) | undefined;
    const fetchImplementation = vi.fn().mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const provider = await FcmServiceAccountTokenProvider.create({
      credentialFile: '/run/secrets/fcm.json',
      projectId: 'padlhub',
      filesystem: filesystem(credential()),
      fetchImplementation,
    });
    const first = provider.getAccessToken();
    const second = provider.getAccessToken();
    expect(fetchImplementation).toHaveBeenCalledOnce();
    resolveFetch?.(
      new Response(JSON.stringify({ access_token: 'coalesced', expires_in: 600 }), { status: 200 }),
    );
    await expect(Promise.all([first, second])).resolves.toEqual(['coalesced', 'coalesced']);
  });
  it('enforces one deadline across headers and a hung response body without caching', async () => {
    const hung = {
      headers: new Headers(),
      ok: true,
      body: {
        getReader: () => ({
          read: () => new Promise(() => undefined),
          cancel: vi.fn().mockResolvedValue(undefined),
        }),
      },
    } as unknown as Response;
    const fetchImplementation = vi
      .fn()
      .mockImplementation(
        () => new Promise<Response>((resolve) => setTimeout(() => resolve(hung), 4)),
      );
    const provider = await FcmServiceAccountTokenProvider.create({
      credentialFile: '/run/secrets/fcm.json',
      projectId: 'padlhub',
      filesystem: filesystem(credential()),
      fetchImplementation,
      timeoutMs: 10,
    });
    await expect(provider.getAccessToken()).rejects.toThrow('FCM_TOKEN_TIMEOUT');
    await expect(provider.getAccessToken()).rejects.toThrow('FCM_TOKEN_TIMEOUT');
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });
  it('rejects an oversized streamed OAuth body before caching', async () => {
    const huge = new Uint8Array(16_385);
    const response = {
      headers: new Headers(),
      ok: true,
      body: {
        getReader: () => ({
          read: vi
            .fn()
            .mockResolvedValueOnce({ done: false, value: huge })
            .mockResolvedValue({ done: true }),
          cancel: vi.fn().mockResolvedValue(undefined),
        }),
      },
    } as unknown as Response;
    const provider = await FcmServiceAccountTokenProvider.create({
      credentialFile: '/run/secrets/fcm.json',
      projectId: 'padlhub',
      filesystem: filesystem(credential()),
      fetchImplementation: vi.fn().mockResolvedValue(response),
    });
    await expect(provider.getAccessToken()).rejects.toThrow('FCM_TOKEN_RESPONSE_TOO_LARGE');
  });
  it('does not erase a newer cached token when invalidating a stale token', async () => {
    let now = 1_000;
    const fetchImplementation = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'old', expires_in: 120 }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'new', expires_in: 120 }), { status: 200 }),
      );
    const provider = await FcmServiceAccountTokenProvider.create({
      credentialFile: '/run/secrets/fcm.json',
      projectId: 'padlhub',
      filesystem: filesystem(credential()),
      fetchImplementation,
      now: () => now,
    });
    await provider.getAccessToken();
    now += 61_000;
    await provider.getAccessToken();
    provider.invalidateAccessToken('old');
    await expect(provider.getAccessToken()).resolves.toBe('new');
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });
  it('rejects insecure files and mismatched projects before OAuth', async () => {
    await expect(
      FcmServiceAccountTokenProvider.create({
        credentialFile: '/run/secrets/fcm.json',
        projectId: 'padlhub',
        filesystem: filesystem(credential(), 0o100644),
      }),
    ).rejects.toThrow('FCM_CREDENTIAL_FILE_PERMISSIONS_INVALID');
    await expect(
      FcmServiceAccountTokenProvider.create({
        credentialFile: '/run/secrets/fcm.json',
        projectId: 'padlhub',
        filesystem: filesystem(credential({ project_id: 'other' })),
      }),
    ).rejects.toThrow('FCM_CREDENTIAL_FILE_INVALID');
    await expect(
      FcmServiceAccountTokenProvider.create({
        credentialFile: '/run/secrets/fcm.json',
        projectId: 'padlhub',
        filesystem: filesystem(credential({ token_uri: 'https://evil.example/token' })),
      }),
    ).rejects.toThrow('FCM_CREDENTIAL_FILE_INVALID');
  });
});
