/* eslint-disable @typescript-eslint/require-await -- Synthetic transport and database boundaries. */
import { createHash, generateKeyPairSync } from 'node:crypto';
import { it, expect, vi } from 'vitest';
import { TournamentChatOwnerClient } from './tournament-chat-owner-client.js';
import emitted from './fixtures/tournament-chat-read-owner-v1.json' with { type: 'json' };
const urlOf = (url: Parameters<typeof fetch>[0]) =>
  typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const a = {
    tenantId: id(1),
    tenantKey: 'synthetic',
    userId: id(2),
    sessionId: id(3),
    correlationId: id(4),
  },
  tid = id(5),
  identity = { ownerTenantKey: 'different-owner', providerClientId: 'synthetic-player' };
const digest = (d: string, v: unknown) =>
  createHash('sha256')
    .update(d + '\0' + JSON.stringify(v))
    .digest('hex');
const witness = {
  kind: 'PARTICIPANT',
  generation: id(6),
  actorHash: digest('tournament-local-actor:v1', [
    identity.ownerTenantKey,
    identity.providerClientId,
  ]),
};
const position = {
  contractVersion: 'tournament-chat-read.v1',
  tournamentId: tid,
  streamId: id(7),
  witness,
  witnessHash: digest('tournament-chat-witness:v1', witness),
  baselineSequence: 0,
  readThroughSequence: 0,
  publishedSequence: 2,
};
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
it('accepts unchanged actual CUP service position, READ and original status wire; strips private witness', async () => {
  const verifyGeneration = vi.fn(async () => undefined);
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const path = urlOf(url);
    if (path.endsWith('/read-position')) return new Response(emitted.wire.position);
    if (path.endsWith('/read-requests/read')) return new Response(emitted.wire.status);
    expect(path).toMatch(/\/read-requests$/);
    expect(typeof init?.body).toBe('string');
    expect(JSON.parse(init!.body as string)).toEqual(emitted.command);
    return new Response(emitted.wire.confirmed);
  });
  const owner = new TournamentChatOwnerClient({
    baseUrl: 'https://cup.invalid',
    tenantId: emitted.actor.tenantId,
    tenantKey: emitted.actor.tenantKey,
    issuer: 'synthetic',
    kid: 'synthetic',
    privateKey,
    identity: async () => emitted.identity,
    verifyGeneration,
    fetchImplementation: fetcher,
  });
  const { tournamentId, requestId, streamId, witnessHash, throughSequence } = emitted.command;
  const publicPosition = await owner.position(emitted.actor, tournamentId);
  const confirmed = await owner.advanceRead(emitted.actor, tournamentId, {
    requestId,
    streamId,
    witnessHash,
    throughSequence,
  });
  const status = await owner.readStatus(emitted.actor, tournamentId, requestId);
  expect(publicPosition).toMatchObject({
    streamId,
    witnessHash,
    publishedSequence: 1,
    readThroughSequence: 0,
  });
  expect(confirmed).toMatchObject({
    status: 'CONFIRMED',
    requestId,
    throughSequence: 1,
    readThroughSequence: 1,
  });
  expect(status).toEqual(confirmed);
  for (const result of [publicPosition, confirmed, status]) {
    expect(result).not.toHaveProperty('witness');
    expect(result).not.toHaveProperty('providerClientId');
    expect(result).not.toHaveProperty('ownerTenantKey');
    expect(JSON.stringify(result)).not.toContain('actorHash');
    expect(JSON.stringify(result)).not.toContain('generation');
  }
  expect(verifyGeneration).toHaveBeenCalledTimes(4);
  expect(
    fetcher.mock.calls.map((call) => urlOf(call[0]).replace('https://cup.invalid', '')),
  ).toEqual([
    '/api/internal/tournaments/chat/v1/read-position',
    '/api/internal/tournaments/chat/v1/read-position',
    '/api/internal/tournaments/chat/v1/read-requests',
    '/api/internal/tournaments/chat/v1/read-requests/read',
  ]);
});
function fixture() {
  const fetcher = vi.fn<typeof fetch>(),
    verifyGeneration = vi.fn(async () => undefined),
    read = vi.fn(async () => identity);
  const owner = new TournamentChatOwnerClient({
    baseUrl: 'https://cup.invalid',
    tenantId: a.tenantId,
    tenantKey: a.tenantKey,
    issuer: 'synthetic',
    kid: 'synthetic',
    privateKey,
    identity: read,
    verifyGeneration,
    fetchImplementation: fetcher,
  });
  return { owner, fetcher, verifyGeneration, read };
}
it('fresh private owner witness resolves exact original JOIN before READ POST; public response redacts witness', async () => {
  const f = fixture();
  f.fetcher.mockImplementation(async (url, init) => {
    if (typeof init?.body !== 'string') throw Error('synthetic-body-required');
    const body = JSON.parse(init.body) as Record<string, unknown>;
    if (urlOf(url).endsWith('/read-position')) return new Response(JSON.stringify(position));
    return new Response(
      JSON.stringify({
        ...position,
        publishedSequence: undefined,
        requestId: body.requestId,
        status: 'CONFIRMED',
        requestHash: digest('tournament-chat-read-request:v1', body),
        throughSequence: 2,
        readThroughSequence: 2,
      }),
    );
  });
  const result = await f.owner.advanceRead(a, tid, {
    requestId: id(8),
    streamId: position.streamId,
    witnessHash: position.witnessHash,
    throughSequence: 2,
  });
  expect(f.verifyGeneration).toHaveBeenCalledWith(a, tid, witness.generation, identity);
  expect('witness' in result).toBe(false);
  expect(result.status).toBe('CONFIRMED');
  expect(f.fetcher.mock.calls.map((c) => urlOf(c[0]).split('/').at(-1))).toEqual([
    'read-position',
    'read-requests',
  ]);
  const [, init] = f.fetcher.mock.calls[1]!,
    headers = init!.headers as Record<string, string>,
    claims = JSON.parse(
      Buffer.from(headers.authorization!.split('.')[1]!, 'base64url').toString(),
    ) as Record<string, unknown>;
  expect(headers['idempotency-key']).toBe(id(8));
  expect(claims.path).toBe('/internal/tournaments/chat/v1/read-requests');
  expect(claims.scope).toBe('tournaments.chat.actor');
});
it('missing/foreign immutable JOIN and witness hash mismatch have zero mutation calls', async () => {
  const f = fixture();
  f.fetcher.mockImplementation(async () => new Response(JSON.stringify(position)));
  f.verifyGeneration.mockRejectedValue(Error('synthetic-invalid-original'));
  await expect(
    f.owner.advanceRead(a, tid, {
      requestId: id(8),
      streamId: position.streamId,
      witnessHash: position.witnessHash,
      throughSequence: 1,
    }),
  ).rejects.toMatchObject({ status: 403 });
  expect(f.fetcher).toHaveBeenCalledTimes(1);
  expect(urlOf(f.fetcher.mock.calls[0]![0])).toMatch(/read-position$/);
  const g = fixture();
  g.fetcher.mockImplementation(
    async () => new Response(JSON.stringify({ ...position, witnessHash: 'f'.repeat(64) })),
  );
  await expect(g.owner.position(a, tid)).rejects.toThrow();
});
it('read status UNKNOWN only invokes owner readonly route and never candidate creation', async () => {
  const f = fixture();
  f.fetcher.mockResolvedValue(
    new Response(
      JSON.stringify({
        contractVersion: 'tournament-chat-read.v1',
        tournamentId: tid,
        requestId: id(8),
        status: 'UNKNOWN',
      }),
    ),
  );
  expect((await f.owner.readStatus(a, tid, id(8))).status).toBe('UNKNOWN');
  expect(f.verifyGeneration).not.toHaveBeenCalled();
  expect(urlOf(f.fetcher.mock.calls[0]![0])).toMatch(/read-requests\/read$/);
});
it('session revoked during immutable JOIN lookup cannot dispatch READ or disclose position', async () => {
  const f = fixture();
  f.fetcher.mockImplementation(async () => new Response(JSON.stringify(position)));
  f.verifyGeneration.mockImplementation(async () => {
    f.read.mockRejectedValue({ status: 403 });
  });
  await expect(
    f.owner.advanceRead(a, tid, {
      requestId: id(8),
      streamId: position.streamId,
      witnessHash: position.witnessHash,
      throughSequence: 1,
    }),
  ).rejects.toMatchObject({ status: 403 });
  expect(f.fetcher).toHaveBeenCalledTimes(1);
});
