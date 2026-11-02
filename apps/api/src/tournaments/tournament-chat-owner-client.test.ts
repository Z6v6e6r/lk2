/* eslint-disable @typescript-eslint/require-await -- Synthetic asynchronous boundary fixtures. */
import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { TournamentChatOwnerClient } from './tournament-chat-owner-client.js';
import { TournamentChatError } from '@phub/domain';
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const actor = {
  tenantId: id(1),
  tenantKey: 'canonical',
  userId: id(2),
  sessionId: id(3),
  correlationId: id(4),
};
const identity = {
  providerClientId: 'synthetic-player',
  ownerTenantKey: 'different-owner-namespace',
};
const tournamentId = id(5),
  requestId = id(6),
  text = '  Привет\n🙂  ';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
function setup() {
  const read = vi.fn(async () => identity);
  const transport = vi.fn<typeof fetch>();
  const owner = new TournamentChatOwnerClient({
    baseUrl: 'https://cup.invalid',
    issuer: 'synthetic-lk2-chat',
    kid: 'test-only',
    privateKey,
    tenantId: actor.tenantId,
    tenantKey: actor.tenantKey,
    identity: read,
    fetchImplementation: transport,
    now: () => 1800000000000,
  });
  return { owner, read, transport };
}
const unknown = {
  contractVersion: 'tournament-chat.v1',
  tournamentId,
  requestId,
  status: 'UNKNOWN',
};
describe('dedicated CUP tournament actor transport', () => {
  it('binds exact purpose, actor, namespace, path, original body and key; never forwards a user token', async () => {
    const { owner, transport, read } = setup();
    transport.mockResolvedValue(new Response(JSON.stringify(unknown)));
    expect(await owner.send(actor, tournamentId, { requestId, text })).toEqual(unknown);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(2);
    const [url, init] = transport.mock.calls[0]!;
    expect(url).toBe('https://cup.invalid/api/internal/tournaments/chat/v1/message-requests');
    const headers = init!.headers as Record<string, string>;
    expect(headers['idempotency-key']).toBe(requestId);
    expect(init!.redirect).toBe('error');
    expect(init!.signal).toBeInstanceOf(AbortSignal);
    const token = headers.authorization!.slice(7),
      [h, p, s] = token.split('.');
    expect(JSON.parse(Buffer.from(h!, 'base64url').toString())).toEqual({
      alg: 'RS256',
      typ: 'phub-tournament-chat-actor+jwt',
      kid: 'test-only',
    });
    expect(
      verify('RSA-SHA256', Buffer.from(h + '.' + p), publicKey, Buffer.from(s!, 'base64url')),
    ).toBe(true);
    expect(JSON.parse(Buffer.from(p!, 'base64url').toString())).toEqual({
      contract_version: 1,
      iss: 'synthetic-lk2-chat',
      aud: 'cup-tournament-chat-v1',
      scope: 'tournaments.chat.actor',
      sub: actor.userId,
      tenant_id: actor.tenantId,
      tenant_key: actor.tenantKey,
      owner_tenant_key: identity.ownerTenantKey,
      provider_client_id: identity.providerClientId,
      session_id: actor.sessionId,
      correlation_id: actor.correlationId,
      method: 'POST',
      path: '/internal/tournaments/chat/v1/message-requests',
      request_sha256: createHash('sha256')
        .update(init!.body as string)
        .digest('hex'),
      jti: expect.any(String) as unknown,
      iat: 1800000000,
      nbf: 1800000000,
      exp: 1800000030,
    });
    expect(JSON.parse(init!.body as string)).toEqual({
      contractVersion: 1,
      tournamentId,
      requestId,
      text,
    });
  });
  it('read-status uses only dedicated readonly operation, no send/fallback', async () => {
    const { owner, transport } = setup();
    transport.mockResolvedValue(new Response(JSON.stringify(unknown)));
    await owner.status(actor, tournamentId, requestId);
    expect(transport.mock.calls[0]![0]).toMatch(/message-requests\/read$/);
    expect(JSON.parse(transport.mock.calls[0]![1]!.body as string)).toEqual({
      contractVersion: 1,
      tournamentId,
      requestId,
    });
    expect(transport.mock.calls[0]![1]!.headers).not.toHaveProperty('idempotency-key');
  });
  it('denies local foreign/session identity before network and final changed identity after network', async () => {
    const { owner, transport, read } = setup();
    await expect(
      owner.status({ ...actor, tenantId: id(9) }, tournamentId, requestId),
    ).rejects.toMatchObject({ status: 403 });
    expect(read).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
    read.mockRejectedValueOnce(new TournamentChatError('TOURNAMENT_CHAT_FORBIDDEN', 403));
    await expect(owner.status(actor, tournamentId, requestId)).rejects.toMatchObject({
      status: 403,
    });
    expect(transport).not.toHaveBeenCalled();
    read
      .mockResolvedValueOnce(identity)
      .mockResolvedValueOnce({ ...identity, providerClientId: 'changed' });
    transport.mockResolvedValue(new Response(JSON.stringify(unknown)));
    await expect(owner.status(actor, tournamentId, requestId)).rejects.toMatchObject({
      status: 403,
    });
  });
  it.each([400, 401, 403, 404, 409])(
    'three expected owner denials %s do not block a different actor',
    async (code) => {
      const { owner, transport } = setup();
      transport.mockImplementation(async () => new Response('{}', { status: code }));
      for (let i = 0; i < 3; i++)
        await expect(owner.status(actor, tournamentId, requestId)).rejects.toBeDefined();
      transport.mockResolvedValueOnce(new Response(JSON.stringify(unknown)));
      await expect(
        owner.status({ ...actor, userId: id(10) }, tournamentId, requestId),
      ).resolves.toEqual(unknown);
      expect(transport).toHaveBeenCalledTimes(4);
    },
  );
  it('final local DB failures do not poison remote breaker', async () => {
    const { owner, transport, read } = setup();
    transport.mockImplementation(async () => new Response(JSON.stringify(unknown)));
    let n = 0;
    read.mockImplementation(async () => {
      if (++n % 2 === 0 && n <= 6) throw Error('synthetic local outage');
      return identity;
    });
    for (let i = 0; i < 3; i++)
      await expect(owner.status(actor, tournamentId, requestId)).rejects.toThrow();
    await expect(owner.status(actor, tournamentId, requestId)).resolves.toEqual(unknown);
    expect(transport).toHaveBeenCalledTimes(4);
  });
  it('malformed responses trip bounded breaker without blind retries', async () => {
    const { owner, transport } = setup();
    transport.mockImplementation(
      async () => new Response(JSON.stringify({ ...unknown, messageId: id(7) })),
    );
    for (let i = 0; i < 4; i++)
      await expect(owner.status(actor, tournamentId, requestId)).rejects.toMatchObject({
        status: 503,
      });
    expect(transport).toHaveBeenCalledTimes(3);
  });
  it('rejects oversized response before parsing and sends no fallback', async () => {
    const { owner, transport } = setup();
    transport.mockResolvedValue(new Response(' '.repeat(8193)));
    await expect(owner.status(actor, tournamentId, requestId)).rejects.toMatchObject({
      status: 503,
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('rejects foreign cursor before owner access', async () => {
    const { owner, transport } = setup();
    const cursor = Buffer.from(
      JSON.stringify({
        v: 1,
        tenantId: id(99),
        tournamentId,
        actorUserId: actor.userId,
        streamId: id(7),
        witnessHash: 'a'.repeat(64),
        through: 20,
        before: 10,
      }),
    ).toString('base64url');
    expect(() => owner.history(actor, tournamentId, 10, cursor)).toThrow();
    expect(transport).not.toHaveBeenCalled();
  });
});
it('rejects corrupt UTF8 history bytes instead of silently replacing message text', async () => {
  const { owner, transport } = setup();
  const page = {
    contractVersion: 'tournament-chat.v1',
    tournamentId,
    streamId: id(7),
    throughSequence: 1,
    messages: [
      {
        messageId: id(8),
        authorUserId: actor.userId,
        text: 'REPLACE_BYTE',
        sequence: 1,
        acceptedAt: '2026-11-01T00:00:00.000Z',
      },
    ],
    hasMore: false,
    nextCursor: null,
  };
  const raw = JSON.stringify(page),
    offset = raw.indexOf('REPLACE_BYTE'),
    bytes = Buffer.concat([
      Buffer.from(raw.slice(0, offset)),
      Buffer.from([0xff]),
      Buffer.from(raw.slice(offset + 'REPLACE_BYTE'.length)),
    ]);
  transport.mockResolvedValue(new Response(bytes));
  await expect(owner.history(actor, tournamentId, 50)).rejects.toMatchObject({ status: 503 });
  expect(transport).toHaveBeenCalledTimes(1);
});
