import { webcrypto } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import {
  PadlHubApiClient,
  parseTournamentChatPage,
  parseTournamentChatReceipt,
  tournamentChatRequestHash,
} from './index.js';
import fixture from '../../domain/src/fixtures/tournament-chat-cup-v1.json';
describe('actual CUP71 synthetic service bytes at SDK boundary', () => {
  it('parses history/receipts and exact original body hashes', async () => {
    for (let i = 0; i < fixture.requests.length; i++) {
      const r = fixture.requests[i]!;
      const hash = await tournamentChatRequestHash(
        r.tournamentId,
        { requestId: r.requestId, text: r.text },
        webcrypto as unknown as Crypto,
      );
      expect(
        parseTournamentChatReceipt(fixture.receipts[i], r.tournamentId, r.requestId, hash),
      ).toEqual(fixture.receipts[i]);
    }
    expect(parseTournamentChatPage(fixture.first, fixture.first.tournamentId, 2)).toEqual(
      fixture.first,
    );
    expect(
      parseTournamentChatPage(
        fixture.last,
        fixture.first.tournamentId,
        2,
        fixture.first.nextCursor,
      ),
    ).toEqual(fixture.last);
    expect(fixture.first.messages[1]!.text).toBe(fixture.last.messages[0]!.text);
    expect(fixture.first.messages[1]!.messageId).not.toBe(fixture.last.messages[0]!.messageId);
  });
  it('uses original key and authenticated dedicated routes; recovery only GET', async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(fixture.receipts[0])))
      .mockResolvedValueOnce(new Response(JSON.stringify(fixture.receipts[0])))
      .mockResolvedValueOnce(new Response(JSON.stringify(fixture.first)));
    const client = new PadlHubApiClient({
      baseUrl: 'https://api.invalid',
      tenantKey: 'synthetic',
      platform: 'web',
      appVersion: 'test',
      fetchImplementation: transport,
    });
    client.setAccessToken('synthetic-access-token');
    const r = fixture.requests[0]!;
    await client.sendTournamentChatMessage(r.tournamentId, {
      requestId: r.requestId,
      text: r.text,
    });
    await client.getTournamentChatRequest(r.tournamentId, r.requestId);
    await client.getTournamentChatHistory(r.tournamentId, 2);
    const calls = transport.mock.calls;
    expect(calls.map((c) => c[1]?.method ?? 'GET')).toEqual(['POST', 'GET', 'GET']);
    expect(new Headers(calls[0]![1]?.headers).get('Idempotency-Key')).toBe(r.requestId);
    expect(new Headers(calls[0]![1]?.headers).get('authorization')).toBe(
      'Bearer synthetic-access-token',
    );
    expect(calls[1]![0]).toContain('/chat/message-requests/' + r.requestId);
    expect(calls[2]![0]).toContain('/chat/messages?limit=2');
  });
  it('401 never retries POST or original status through another endpoint', async () => {
    const transport = vi.fn<typeof fetch>().mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            code: 'AUTH_REQUIRED',
            message: 'Denied',
            correlationId: 'synthetic',
          }),
          { status: 401 },
        ),
      ),
    );
    const client = new PadlHubApiClient({
      baseUrl: 'https://api.invalid',
      tenantKey: 'synthetic',
      platform: 'web',
      appVersion: 'test',
      fetchImplementation: transport,
    });
    client.setAccessToken('synthetic-access-token');
    const r = fixture.requests[0]!;
    await expect(
      client.sendTournamentChatMessage(r.tournamentId, { requestId: r.requestId, text: r.text }),
    ).rejects.toThrow();
    await expect(client.getTournamentChatRequest(r.tournamentId, r.requestId)).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(2);
  });
});

it('explicit READ uses original metadata, no automatic POST for restore and no dispatch after token change during hash', async () => {
  const id = '10000000-0000-4000-8000-000000000001',
    requestId = '10000000-0000-4000-8000-000000000002';
  const unknown = {
    contractVersion: 'tournament-chat-read.v1',
    tournamentId: id,
    requestId,
    status: 'UNKNOWN',
  };
  const transport = vi
    .fn<typeof fetch>()
    .mockImplementation(() => Promise.resolve(new Response(JSON.stringify(unknown))));
  const client = new PadlHubApiClient({
    baseUrl: 'https://api.invalid',
    tenantKey: 'synthetic',
    platform: 'web',
    appVersion: 'test',
    fetchImplementation: transport,
  });
  client.setAccessToken('synthetic-original');
  await client.getTournamentChatReadRequest(id, requestId);
  expect(transport.mock.calls[0]![1]?.method ?? 'GET').toBe('GET');
  const input = { requestId, streamId: id, witnessHash: 'a'.repeat(64), throughSequence: 1 };
  await client.advanceTournamentChatRead(id, input);
  expect(transport.mock.calls[1]![1]?.method).toBe('POST');
  expect(new Headers(transport.mock.calls[1]![1]?.headers).get('Idempotency-Key')).toBe(requestId);
  const digest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
  const spy = vi
    .spyOn(globalThis.crypto.subtle, 'digest')
    .mockImplementationOnce(async (...args) => {
      client.setAccessToken('synthetic-replaced');
      return digest(...args);
    });
  try {
    await expect(client.advanceTournamentChatRead(id, input)).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(2);
  } finally {
    spy.mockRestore();
  }
});

it('MESSAGE token replacement during digest never reaches fetch without a gateway callback', async () => {
  const transport = vi.fn<typeof fetch>();
  const client = new PadlHubApiClient({
    baseUrl: 'https://api.invalid',
    tenantKey: 'synthetic',
    platform: 'web',
    appVersion: 'test',
    fetchImplementation: transport,
  });
  const request = fixture.requests[0]!;
  client.setAccessToken('synthetic-original');
  const digest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
  const spy = vi.spyOn(globalThis.crypto.subtle, 'digest').mockImplementationOnce((...args) => {
    client.setAccessToken('synthetic-replacement');
    return digest(...args);
  });
  try {
    await expect(
      client.sendTournamentChatMessage(request.tournamentId, {
        requestId: request.requestId,
        text: request.text,
      }),
    ).rejects.toMatchObject({ code: 'TOURNAMENT_CHAT_FORBIDDEN' });
    expect(transport).not.toHaveBeenCalled();
  } finally {
    spy.mockRestore();
  }
});

it('MESSAGE per-call original principal is checked again before exposing the response', async () => {
  let current = true;
  const request = fixture.requests[0]!;
  const transport = vi.fn<typeof fetch>(() => {
    current = false;
    return Promise.resolve(new Response(JSON.stringify(fixture.receipts[0])));
  });
  const client = new PadlHubApiClient({
    baseUrl: 'https://api.invalid',
    tenantKey: 'synthetic',
    platform: 'web',
    appVersion: 'test',
    fetchImplementation: transport,
  });
  client.setAccessToken('synthetic-original');
  await expect(
    client.sendTournamentChatMessage(
      request.tournamentId,
      { requestId: request.requestId, text: request.text },
      () => {
        if (!current) throw Error('AUTH_PRINCIPAL_CHANGED');
      },
    ),
  ).rejects.toThrow('AUTH_PRINCIPAL_CHANGED');
  expect(transport).toHaveBeenCalledTimes(1);
});
