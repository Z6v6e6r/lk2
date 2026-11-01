import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { CommunityLegacyBridgeRepository } from '@phub/communities';
import { StationStreamOwnerClient } from './station-stream-owner-client.js';
type Fixture = {
  history: unknown;
  readRequest: {
    requestId: string;
    streamId: string;
    membershipEpoch: number;
    throughSequence: number;
  };
  receipt: unknown;
  summary: { items: { communityId: string }[] };
};
const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/station-stream-v3.json', import.meta.url), 'utf8'),
) as Fixture;
const id = '11111111-1111-4111-8111-111111111111',
  other = '22222222-2222-4222-8222-222222222222';
const actor = {
  tenantId: id,
  userId: other,
  tenantKey: 'test',
  sessionId: 'session',
  correlationId: 'correlation',
  communityId: id,
};
function setup(payload: unknown = fixture.history, status = 200) {
  const mapping = vi.fn(() =>
    Promise.resolve(new Map([[id, fixture.summary.items[0]!.communityId]])),
  );
  const token = vi.fn(() => Promise.resolve('synthetic-user-delegation'));
  const transport = vi.fn<typeof fetch>(() =>
    Promise.resolve(new Response(JSON.stringify(payload), { status })),
  );
  const metrics = vi.fn();
  const bridge = {
    getCommunityExternalIds: mapping,
    getViewerIdentity: () => Promise.resolve({ clientId: 'viewer', phoneE164: '+12025550101' }),
  } as unknown as CommunityLegacyBridgeRepository;
  const client = new StationStreamOwnerClient({
    baseUrl: 'https://owner.invalid',
    timeoutMs: 3000,
    bridge,
    token,
    fetchImplementation: transport,
    onMetric: metrics,
  });
  return { client, mapping, token, transport, metrics };
}
describe('station v3 concrete owner adapter', () => {
  it('accepts actual owner fixture and strips all private author fields', async () => {
    expect(
      createHash('sha256')
        .update(readFileSync(new URL('./fixtures/station-stream-v3.json', import.meta.url)))
        .digest('hex'),
    ).toBe('40093222ddf4c9b020f48868dc4dd08a02d490949d57b091ba42e4aa35ee2385');
    const h = setup();
    const page = await h.client.history(actor, 50);
    expect(page.historyVersion).toBe(3);
    expect(JSON.stringify(page)).not.toMatch(/authorPhone|authorId|createdTs|communityId/);
    const [url, init] = h.transport.mock.calls[0]!;
    expect(url instanceof Request ? url.url : url.toString()).toContain('historyVersion=3');
    expect(url instanceof Request ? url.url : url.toString()).not.toMatch(/phone|clientId/);
    expect(init?.redirect).toBe('error');
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer synthetic-user-delegation' });
    expect(JSON.stringify(h.metrics.mock.calls)).not.toMatch(
      /delegation|viewer|1202555|owner.invalid/,
    );
  });
  it('batch maps exactly and only explicit owner alternatives permit legacy', async () => {
    const h = setup(fixture.summary);
    expect((await h.client.summaries(actor, [id])).items[0]?.communityId).toBe(id);
    expect(h.mapping).toHaveBeenCalledOnce();
    expect(h.transport.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      headers: { 'X-PadlHub-Community-Stream-Contract': 'station-stream.v1' },
    });
    for (const availability of ['UNADOPTED', 'NOT_STATION']) {
      const p = {
        contractVersion: 1,
        contract: 'station-stream-summaries',
        items: [{ communityId: fixture.summary.items[0]!.communityId, availability }],
      };
      expect((await setup(p).client.summaries(actor, [id])).items[0]?.availability).toBe(
        availability,
      );
    }
    await expect(
      setup({
        contractVersion: 1,
        contract: 'station-stream-summaries',
        items: [
          { communityId: fixture.summary.items[0]!.communityId, availability: 'UNAVAILABLE' },
        ],
      }).client.summaries(actor, [id]),
    ).rejects.toThrow();
  });
  it('missing, duplicate, foreign mapping or invalid actor never delegates', async () => {
    for (const map of [new Map<string, string>(), new Map([[other, 'foreign']])]) {
      const h = setup();
      h.mapping.mockResolvedValue(map);
      await expect(h.client.history(actor, 50)).rejects.toThrow();
      expect(h.transport).not.toHaveBeenCalled();
      expect(h.token).not.toHaveBeenCalled();
    }
    const h = setup();
    await expect(h.client.summaries({ ...actor, userId: '' }, [id])).rejects.toThrow();
    expect(h.mapping).not.toHaveBeenCalled();
  });
  it('exact read receipt parity and read-only status route', async () => {
    const h = setup(fixture.receipt);
    expect(await h.client.read(actor, fixture.readRequest)).toEqual(fixture.receipt);
    await h.client.readStatus(actor, fixture.readRequest.requestId);
    expect(h.transport.mock.calls.map((v) => v[1]?.method)).toEqual(['POST', 'GET']);
    expect(h.transport.mock.calls[1]?.[1]?.body).toBeUndefined();
    await expect(
      setup({ ...(fixture.receipt as object), throughSequence: 999 }).client.read(
        actor,
        fixture.readRequest,
      ),
    ).rejects.toThrow();
  });
  it.each([200, 400, 401, 403, 409, 503])(
    'accepts only exact UNKNOWN at status %i without changing request',
    async (status) => {
      const body = {
        contractVersion: 1,
        contract: 'station-read',
        requestId: fixture.readRequest.requestId,
        outcome: 'UNKNOWN',
        code: 'READ_RECEIPT_UNPROVEN',
      };
      expect(await setup(body, status).client.read(actor, fixture.readRequest)).toEqual(body);
      await expect(
        setup({ ...body, code: 'other' }, status).client.read(actor, fixture.readRequest),
      ).rejects.toThrow();
    },
  );
  it('has no retry, rejects redirects and opens bounded circuit after failures', async () => {
    const h = setup();
    h.transport.mockRejectedValue(new TypeError('offline'));
    for (let i = 0; i < 4; i++) await expect(h.client.history(actor, 50)).rejects.toThrow();
    expect(h.transport).toHaveBeenCalledTimes(3);
    const r = setup();
    const redirected = new Response('{}');
    Object.defineProperty(redirected, 'url', { value: 'https://foreign.invalid' });
    r.transport.mockResolvedValue(redirected);
    await expect(r.client.history(actor, 50)).rejects.toThrow();
  });
  it('rejects extra receipt fields and confused success on non200', async () => {
    await expect(
      setup({ ...(fixture.receipt as object), authorPhone: 'private' }).client.read(
        actor,
        fixture.readRequest,
      ),
    ).rejects.toThrow();
    await expect(
      setup(fixture.receipt, 409).client.read(actor, fixture.readRequest),
    ).rejects.toThrow();
  });
  it.each(['throw', 'empty'] as const)(
    'actor token %s cannot poison the shared owner breaker',
    async (mode) => {
      const h = setup();
      if (mode === 'throw') h.token.mockRejectedValue(new Error('ACTOR_DENIED'));
      else h.token.mockResolvedValue('');
      for (let i = 0; i < 3; i++) await expect(h.client.history(actor, 50)).rejects.toThrow();
      expect(h.transport).not.toHaveBeenCalled();
      h.token.mockResolvedValue('synthetic-valid-user');
      await expect(h.client.history({ ...actor, userId: id }, 50)).resolves.toMatchObject({
        historyVersion: 3,
      });
      expect(h.transport).toHaveBeenCalledOnce();
    },
  );
  it.each([401, 403])(
    'malformed read/status auth %i never charges shared dependency failures',
    async (status) => {
      const h = setup();
      h.transport.mockImplementation(() => Promise.resolve(new Response('malformed', { status })));
      for (let i = 0; i < 3; i++)
        await expect(
          i % 2
            ? h.client.readStatus(actor, fixture.readRequest.requestId)
            : h.client.read(actor, fixture.readRequest),
        ).rejects.toThrow();
      h.transport.mockImplementation(() => Promise.resolve(Response.json(fixture.history)));
      await expect(h.client.history({ ...actor, userId: id }, 50)).resolves.toMatchObject({
        historyVersion: 3,
      });
      expect(h.transport).toHaveBeenCalledTimes(4);
    },
  );
  it.each([200, 503])(
    'malformed dependency response %i still opens the bounded breaker',
    async (status) => {
      const h = setup();
      h.transport.mockImplementation(() => Promise.resolve(new Response('malformed', { status })));
      for (let i = 0; i < 4; i++)
        await expect(h.client.read(actor, fixture.readRequest)).rejects.toThrow();
      expect(h.transport).toHaveBeenCalledTimes(3);
    },
  );
  it('valid503 UNKNOWN retains receipt semantics but still charges dependency failure', async () => {
    const unknown = {
      contractVersion: 1,
      contract: 'station-read',
      requestId: fixture.readRequest.requestId,
      outcome: 'UNKNOWN',
      code: 'READ_STREAM_UNAVAILABLE',
    };
    const h = setup(unknown, 503);
    for (let i = 0; i < 3; i++)
      expect(await h.client.read(actor, fixture.readRequest)).toEqual(unknown);
    await expect(h.client.read(actor, fixture.readRequest)).rejects.toThrow();
    expect(h.transport).toHaveBeenCalledTimes(3);
  });
});
