import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { chmod, link, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { connect } from 'node:http2';
import type { PushDeliveryRequest } from '@phub/notifications';
import { ApnsDeliveryAdapter, ApnsTokenProvider } from './apns-adapter.js';
import { YandexSmtpAdapter, type SmtpTransport } from './yandex-smtp-adapter.js';
import { readNotificationCredentialFile } from './notification-provider-credentials.js';

const folders: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function privateFile(value: unknown): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'scenario-provider-test-')));
  folders.push(root);
  const path = join(root, 'credential.json');
  await writeFile(path, JSON.stringify(value), { mode: 0o600 });
  return path;
}
const request: PushDeliveryRequest = {
  tenantId: randomUUID(),
  deliveryId: randomUUID(),
  providerAccountId: randomUUID(),
  platform: 'IOS',
  endpoint: 'a'.repeat(64),
  providerIdempotencyKey: 'synthetic-provider-key',
  notification: {
    id: randomUUID(),
    title: 'Private title',
    preview: 'Private preview',
    deepLink: '/private',
  },
};
function connection(status: number, body: unknown = {}, pending = false) {
  const stream = Object.assign(new EventEmitter(), {
    end: vi.fn((payload: string) => {
      void payload;
      if (!pending)
        queueMicrotask(() => {
          stream.emit('response', { ':status': status, 'apns-id': request.deliveryId });
          stream.emit('data', Buffer.from(JSON.stringify(body)));
          stream.emit('end');
        });
    }),
    close: vi.fn(),
  });
  const session = Object.assign(new EventEmitter(), {
    request: vi.fn(() => stream),
    destroy: vi.fn(),
  });
  const factory = vi.fn(() => session);
  return { factory: factory as unknown as typeof connect, session, stream };
}
describe('APNs transport', () => {
  it('uses the fixed Apple environment, scoped topic, stable IDs and a private generic alert', async () => {
    const c = connection(200);
    const provider = { getToken: vi.fn(() => 'synthetic-token'), invalidate: vi.fn() };
    const adapter = new ApnsDeliveryAdapter({
      topic: 'ru.padlhub.app',
      environment: 'SANDBOX',
      tokenProvider: provider,
      timeoutMs: 1000,
      connectImplementation: c.factory,
    });
    expect(await adapter.send(request)).toEqual({
      outcome: 'accepted',
      externalMessageId: request.deliveryId,
    });
    expect(c.factory).toHaveBeenCalledWith('https://api.sandbox.push.apple.com', expect.anything());
    expect(c.session.request).toHaveBeenCalledWith(
      expect.objectContaining({
        'apns-topic': 'ru.padlhub.app',
        'apns-id': request.deliveryId,
        ':path': `/3/device/${request.endpoint}`,
      }),
    );
    const payload = c.stream.end.mock.calls[0]![0];
    expect(payload).not.toContain('Private');
    expect(payload).toContain('/notifications');
    expect(c.session.destroy).toHaveBeenCalled();
  });
  it.each([
    {
      status: 410,
      body: { reason: 'Unregistered' },
      outcome: 'terminal_failure',
      code: 'APNS_TOKEN_INVALID',
    },
    { status: 429, body: {}, outcome: 'retryable_failure', code: 'APNS_PROVIDER_RETRYABLE' },
    { status: 503, body: {}, outcome: 'retryable_failure', code: 'APNS_PROVIDER_RETRYABLE' },
    { status: 403, body: {}, outcome: 'retryable_failure', code: 'APNS_AUTH_REJECTED' },
  ])('classifies provider response $status without retaining body', async (row) => {
    const c = connection(row.status, row.body);
    const provider = { getToken: () => 'synthetic-token', invalidate: vi.fn() };
    const result = await new ApnsDeliveryAdapter({
      topic: 'ru.padlhub.app',
      environment: 'PRODUCTION',
      tokenProvider: provider,
      timeoutMs: 1000,
      connectImplementation: c.factory,
    }).send(request);
    expect(result).toMatchObject({ outcome: row.outcome, errorCode: row.code });
    if (row.status === 403) expect(provider.invalidate).toHaveBeenCalled();
  });
  it('closes a hung HTTP/2 session before the bounded result and opens a circuit after repeated failures', async () => {
    vi.useFakeTimers();
    const c = connection(200, {}, true);
    const adapter = new ApnsDeliveryAdapter({
      topic: 'ru.padlhub.app',
      environment: 'SANDBOX',
      tokenProvider: { getToken: () => 'synthetic-token', invalidate: vi.fn() },
      timeoutMs: 500,
      connectImplementation: c.factory,
    });
    for (let i = 0; i < 3; i++) {
      const pending = adapter.send(request);
      await vi.advanceTimersByTimeAsync(501);
      expect(await pending).toMatchObject({ errorCode: 'APNS_OUTCOME_UNKNOWN' });
    }
    expect(c.session.destroy).toHaveBeenCalledTimes(3);
    expect(await adapter.send(request)).toMatchObject({ errorCode: 'APNS_CIRCUIT_OPEN' });
  });
  it('validates the EC key and generates a bounded ES256 JWT that is cached and invalidatable', async () => {
    const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
      .privateKey.export({ format: 'pem', type: 'pkcs8' })
      .toString();
    const provider = await ApnsTokenProvider.create(
      await privateFile({ teamId: 'ABCDEFGHIJ', keyId: 'KLMNOPQRST', privateKey: key }),
      () => 1760000000000,
    );
    const token = provider.getToken();
    const parts = token.split('.');
    expect(JSON.parse(Buffer.from(parts[0]!, 'base64url').toString())).toEqual({
      alg: 'ES256',
      kid: 'KLMNOPQRST',
    });
    expect(Buffer.from(parts[2]!, 'base64url')).toHaveLength(64);
    expect(provider.getToken()).toBe(token);
    provider.invalidate();
    expect(provider.getToken().split('.')).toHaveLength(3);
  });
});
describe('Yandex corporate SMTP', () => {
  async function fixture(send: SmtpTransport['sendMail'], timeoutMs = 1000) {
    const transport = { sendMail: vi.fn(send), close: vi.fn() };
    const factory = vi.fn(() => transport);
    const adapter = await YandexSmtpAdapter.create({
      credentialFile: await privateFile({
        login: 'mailbox@example.test',
        password: 'synthetic-app-password',
      }),
      timeoutMs,
      transportFactory: factory,
    });
    return { adapter, transport, factory };
  }
  const email = {
    deliveryId: randomUUID(),
    address: 'recipient@example.test',
    title: 'Training',
    body: 'Synthetic text',
  };
  it('pins implicit TLS Yandex SMTP and the authenticated sender; sends text only with a stable message ID', async () => {
    const f = await fixture(() =>
      Promise.resolve({ accepted: [email.address], rejected: [], messageId: 'synthetic-id' }),
    );
    expect(await f.adapter.send(email)).toEqual({
      outcome: 'accepted',
      externalMessageId: 'synthetic-id',
    });
    expect(f.factory).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'smtp.yandex.ru',
        port: 465,
        secure: true,
        requireTLS: true,
        tls: expect.objectContaining({ rejectUnauthorized: true }) as unknown,
        disableFileAccess: true,
        disableUrlAccess: true,
      }),
    );
    expect(f.transport.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        envelope: { from: 'mailbox@example.test', to: [email.address] },
        messageId: `<${email.deliveryId}@example.test>`,
        text: email.body,
      }),
    );
    expect(f.transport.close).toHaveBeenCalled();
  });
  it('rejects header injection before opening the transport', async () => {
    const f = await fixture(vi.fn());
    expect(
      await f.adapter.send({ ...email, title: 'Test\r\nBcc: someone@example.test' }),
    ).toMatchObject({ errorCode: 'SMTP_MESSAGE_INVALID' });
    expect(f.factory).not.toHaveBeenCalled();
  });
  it('closes a blocked transport at the total deadline, before a retry can start', async () => {
    const f = await fixture(() => new Promise(() => {}), 500);
    vi.useFakeTimers();
    const pending = f.adapter.send(email);
    await vi.advanceTimersByTimeAsync(501);
    expect(await pending).toMatchObject({
      outcome: 'terminal_failure',
      errorCode: 'SMTP_OUTCOME_UNKNOWN',
    });
    expect(f.transport.close).toHaveBeenCalled();
  });
  it('treats authenticated-recipient rejection as terminal and auth failure as retryable', async () => {
    const f = await fixture(() =>
      Promise.reject(
        Object.assign(new Error('synthetic'), { responseCode: 550, code: 'EENVELOPE' }),
      ),
    );
    expect(await f.adapter.send(email)).toMatchObject({
      outcome: 'terminal_failure',
      errorCode: 'SMTP_RECIPIENT_REJECTED',
    });
    const g = await fixture(() =>
      Promise.reject(Object.assign(new Error('synthetic'), { responseCode: 535, code: 'EAUTH' })),
    );
    expect(await g.adapter.send(email)).toMatchObject({
      outcome: 'retryable_failure',
      errorCode: 'SMTP_AUTH_REJECTED',
    });
  });
});
describe('notification credential custody', () => {
  it('refuses broad permissions, symlinks and hardlinks before parsing', async () => {
    const path = await privateFile({ synthetic: true });
    await chmod(path, 0o644);
    await expect(readNotificationCredentialFile(path)).rejects.toThrow('METADATA');
    await chmod(path, 0o600);
    await symlink(path, path + '.link');
    await expect(readNotificationCredentialFile(path + '.link')).rejects.toThrow('PATH');
    await link(path, path + '.hard');
    await expect(readNotificationCredentialFile(path)).rejects.toThrow('METADATA');
  });
});
