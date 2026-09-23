import { describe, expect, it, vi } from 'vitest';

import {
  LegacyStationSupportClient,
  normalizeSupportPhoneDigits,
} from './station-support-provider.js';

const baseUrl = 'https://support.padlhub.test/lk/support';

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

function requestBody(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body');
  return JSON.parse(init.body) as Record<string, unknown>;
}

function client(overrides: {
  readonly fetchImplementation: typeof fetch;
  readonly maxAttempts?: number;
  readonly circuitFailureThreshold?: number;
  readonly circuitResetMs?: number;
  readonly timeoutMs?: number;
  readonly onMetric?: (metric: { readonly code?: string }) => void;
}) {
  return new LegacyStationSupportClient({
    baseUrl,
    timeoutMs: overrides.timeoutMs ?? 1_000,
    maxAttempts: overrides.maxAttempts ?? 2,
    circuitFailureThreshold: overrides.circuitFailureThreshold ?? 3,
    circuitResetMs: overrides.circuitResetMs ?? 30_000,
    fetchImplementation: overrides.fetchImplementation,
    ...(overrides.onMetric ? { onMetric: overrides.onMetric } : {}),
  });
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('legacy station support client', () => {
  it('reads dialogs and messages with the viewer phone and no leaked identifiers', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockImplementation((request) => {
      const url = requestUrl(request);
      if (url.includes('/messages')) {
        return Promise.resolve(
          jsonResponse({
            messages: [
              {
                id: 'm1',
                dialogId: 'd1',
                direction: 'INBOUND',
                authorType: 'CLIENT',
                text: 'Здравствуйте',
                createdTs: 1_758_532_800_000,
                externalMessageId: 'client-message-0001',
              },
            ],
          }),
        );
      }
      return Promise.resolve(
        jsonResponse({
          dialogs: [
            {
              id: 'd1',
              stationId: 'Yasenevo',
              stationName: 'Ясенево',
              status: 'OPEN',
              updatedTs: 1_758_532_800_000,
              lastMessage: { preview: 'Здравствуйте', direction: 'INBOUND', authorType: 'CLIENT' },
            },
          ],
        }),
      );
    });
    const support = client({ fetchImplementation });
    const dialogs = await support.listDialogs({
      phoneDigits: '79990000001',
      correlationId: 'correlation-1',
    });
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0]).toMatchObject({
      dialogId: 'd1',
      stationId: 'Yasenevo',
      lastMessage: { direction: 'INBOUND', authorType: 'CLIENT' },
    });
    const firstUrl = requestUrl(fetchImplementation.mock.calls[0]?.[0] ?? new URL(baseUrl));
    expect(firstUrl).toContain('/lk/support/dialogs?');
    expect(firstUrl).toContain('phone=79990000001');
    expect(firstUrl).toContain('channel=WEB');
    expect(fetchImplementation.mock.calls[0]?.[1]?.redirect).toBe('error');

    const messages = await support.listMessages({
      dialogId: 'd1',
      limit: 50,
      beforeTs: 1_758_532_800_001,
      correlationId: 'correlation-1',
    });
    expect(messages[0]).toMatchObject({
      messageId: 'm1',
      externalMessageId: 'client-message-0001',
    });
  });

  it('sends exactly one viewer phone and never asks the provider to merge identities', async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ ok: true, dialog: { id: 'd1' } }));
    const support = client({ fetchImplementation });
    const result = await support.sendEvent({
      phoneDigits: '79990000001',
      externalUserId: 'user-1',
      externalChatId: 'lk2:user-1',
      displayName: 'Игрок ПадлХАБ',
      text: 'Здравствуйте',
      stationId: 'Yasenevo',
      stationName: 'Ясенево',
      externalMessageId: 'station-message-000001',
      correlationId: 'correlation-1',
    });
    expect(result).toEqual({ dialogId: 'd1' });
    const init = fetchImplementation.mock.calls[0]?.[1];
    expect(requestUrl(fetchImplementation.mock.calls[0]?.[0] ?? new URL(baseUrl))).toBe(
      `${baseUrl}/dialogs/events`,
    );
    const body = requestBody(init);
    expect(body).toMatchObject({
      phone: '79990000001',
      stationId: 'Yasenevo',
      externalMessageId: 'station-message-000001',
    });
    // The CUP ingest validates with `forbidNonWhitelisted`, so the body may carry only properties
    // that DTO declares: an extra one refuses the whole command with HTTP 400. `phoneNumber` was
    // exactly that extra property and every station message was rejected by it.
    expect(body).not.toHaveProperty('phoneNumber');
    expect(Object.keys(body).sort()).toEqual([
      'authStatus',
      'authorType',
      'channel',
      'connector',
      'direction',
      'displayName',
      'eventType',
      'externalChatId',
      'externalMessageId',
      'externalUserId',
      'kind',
      'phone',
      'primaryPhone',
      'stationId',
      'stationName',
      'text',
    ]);
    // An explicit `kind` keeps the message an actionable client text; without it the ingest reads
    // the station-carrying event as a `STATION_SELECTION` system event.
    expect(body).toMatchObject({
      kind: 'TEXT',
      direction: 'INBOUND',
      authorType: 'CLIENT',
    });
    // Exactly one viewer number: the provider asked never to merge two numbers into one client.
    expect(body.primaryPhone).toBe(body.phone);
  });

  it('retries a bounded transient failure and reports only redacted metrics', async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('nope', { status: 503 }))
      .mockResolvedValueOnce(jsonResponse({ dialogs: [] }));
    const onMetric = vi.fn();
    const support = client({ fetchImplementation, onMetric });
    await expect(
      support.listDialogs({ phoneDigits: '79990000001', correlationId: 'correlation-1' }),
    ).resolves.toEqual([]);
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    expect(onMetric).toHaveBeenLastCalledWith(
      expect.objectContaining({ operation: 'list-dialogs', outcome: 'success', attempt: 2 }),
    );
    expect(JSON.stringify(onMetric.mock.calls)).not.toContain('79990000001');
  });

  it('treats a rejected command as terminal, distinct and free of circuit impact', async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('bad request', { status: 400 }));
    const support = client({ fetchImplementation, circuitFailureThreshold: 2 });
    const send = () =>
      support.sendEvent({
        phoneDigits: '79990000001',
        externalUserId: 'user-1',
        externalChatId: 'lk2:user-1',
        displayName: 'Игрок ПадлХАБ',
        text: 'Здравствуйте',
        stationId: 'Yasenevo',
        stationName: 'Ясенево',
        externalMessageId: 'station-message-000001',
        correlationId: 'correlation-1',
      });
    await expect(send()).rejects.toMatchObject({ code: 'SUPPORT_PROVIDER_REJECTED' });
    await expect(send()).rejects.toMatchObject({ code: 'SUPPORT_PROVIDER_REJECTED' });
    await expect(send()).rejects.toMatchObject({ code: 'SUPPORT_PROVIDER_REJECTED' });
    expect(fetchImplementation).toHaveBeenCalledTimes(3);
    // Three refused commands must not open the shared circuit.
    await expect(
      support.listDialogs({ phoneDigits: '79990000001', correlationId: 'correlation-1' }),
    ).rejects.toMatchObject({ code: 'SUPPORT_PROVIDER_REJECTED' });
  });

  it('never retries the provider write and reuses the external message id when asked again', async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('unavailable', { status: 503 }));
    const support = client({ fetchImplementation, maxAttempts: 2 });
    const send = () =>
      support.sendEvent({
        phoneDigits: '79990000001',
        externalUserId: 'user-1',
        externalChatId: 'lk2:user-1',
        displayName: 'Игрок ПадлХАБ',
        text: 'Здравствуйте',
        stationId: 'Yasenevo',
        stationName: 'Ясенево',
        externalMessageId: 'station-message-000001',
        correlationId: 'correlation-1',
      });
    await expect(send()).rejects.toMatchObject({ code: 'SUPPORT_PROVIDER_UNAVAILABLE' });
    await send().catch(() => undefined);
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    const bodies = fetchImplementation.mock.calls.map(([, init]) => requestBody(init));
    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
      expect(body.externalMessageId).toBe('station-message-000001');
    }
  });

  it('reports a malformed success body as a failure and counts it once', async () => {
    const onMetric = vi.fn();
    const support = client({
      fetchImplementation: vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response('not json', { status: 200 })),
      onMetric,
    });
    await expect(
      support.listDialogs({ phoneDigits: '79990000001', correlationId: 'correlation-1' }),
    ).rejects.toMatchObject({ code: 'SUPPORT_PROVIDER_INVALID_RESPONSE' });
    expect(onMetric).toHaveBeenCalledTimes(1);
    expect(onMetric).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'failure', status: 200 }),
    );
  });

  it('accepts a numeric provider station id instead of collapsing it to null', async () => {
    const support = client({
      fetchImplementation: vi
        .fn<typeof fetch>()
        .mockResolvedValue(jsonResponse({ dialogs: [{ id: 42, stationId: 7, status: 'OPEN' }] })),
    });
    await expect(
      support.listDialogs({ phoneDigits: '79990000001', correlationId: 'correlation-1' }),
    ).resolves.toMatchObject([{ dialogId: '42', stationId: '7' }]);
  });

  it('carries the operator name and only the pictures the API may materialize', async () => {
    const support = client({
      fetchImplementation: vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse({
          messages: [
            {
              id: 'm1',
              dialogId: 'd1',
              direction: 'OUTBOUND',
              authorType: 'ADMIN',
              text: '',
              sender: { id: 'operator-1', name: 'ПадлХАБ • Супервайзер' },
              createdTs: 1_758_532_800_000,
              attachments: [
                {
                  type: 'IMAGE',
                  url: 'data:image/png;base64,AAAA',
                  name: 'мяч.png',
                  mimeType: 'image/png',
                  size: 12,
                },
                { type: 'IMAGE', url: 'https://padlhub.su/uploads/photo.png', name: 'фото.png' },
                // A non-image and an unaddressed scheme never reach the materializer.
                { type: 'FILE', url: 'https://padlhub.su/uploads/смета.pdf' },
                { type: 'IMAGE', url: 'javascript:alert(1)' },
              ],
            },
          ],
        }),
      ),
    });
    const messages = await support.listMessages({
      dialogId: 'd1',
      limit: 50,
      beforeTs: 1,
      correlationId: 'correlation-1',
    });
    expect(messages[0]?.senderName).toBe('ПадлХАБ • Супервайзер');
    expect(messages[0]?.attachments).toEqual([
      expect.objectContaining({ type: 'IMAGE', name: 'мяч.png', mimeType: 'image/png', size: 12 }),
      expect.objectContaining({ type: 'IMAGE', name: 'фото.png', mimeType: null, size: null }),
    ]);
  });

  it('adds the attachment array only when a picture is actually attached', async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ ok: true, dialog: { id: 'd1' } }));
    const support = client({ fetchImplementation });
    await support.sendEvent({
      phoneDigits: '79990000001',
      externalUserId: 'user-1',
      externalChatId: 'lk2:user-1',
      displayName: 'Игрок ПадлХАБ',
      text: 'Фото: корт.png',
      stationId: 'Yasenevo',
      stationName: 'Ясенево',
      attachments: [
        {
          type: 'IMAGE',
          url: 'data:image/webp;base64,AAAA',
          name: 'корт.png',
          mimeType: 'image/webp',
          size: 4,
        },
      ],
      externalMessageId: 'station-message-000002',
      correlationId: 'correlation-1',
    });
    expect(requestBody(fetchImplementation.mock.calls[0]?.[1])).toMatchObject({
      text: 'Фото: корт.png',
      attachments: [
        {
          type: 'IMAGE',
          url: 'data:image/webp;base64,AAAA',
          name: 'корт.png',
          mimeType: 'image/webp',
          size: 4,
        },
      ],
    });
  });

  it('opens the circuit after repeated failures and stops calling the provider', async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('nope', { status: 503 }));
    const support = client({
      fetchImplementation,
      maxAttempts: 1,
      circuitFailureThreshold: 2,
    });
    const call = () =>
      support.listDialogs({ phoneDigits: '79990000001', correlationId: 'correlation-1' });
    await expect(call()).rejects.toMatchObject({ code: 'SUPPORT_PROVIDER_UNAVAILABLE' });
    await expect(call()).rejects.toMatchObject({ code: 'SUPPORT_PROVIDER_UNAVAILABLE' });
    const callsBeforeOpen = fetchImplementation.mock.calls.length;
    await expect(call()).rejects.toMatchObject({ code: 'SUPPORT_PROVIDER_CIRCUIT_OPEN' });
    expect(fetchImplementation).toHaveBeenCalledTimes(callsBeforeOpen);
  });

  it('maps an aborted request to a timeout and rejects an oversized provider body', async () => {
    const hanging = vi.fn<typeof fetch>().mockImplementation(
      (_request, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        }),
    );
    const timingOut = client({ fetchImplementation: hanging, timeoutMs: 5, maxAttempts: 1 });
    await expect(
      timingOut.listDialogs({ phoneDigits: '79990000001', correlationId: 'correlation-1' }),
    ).rejects.toMatchObject({ code: 'SUPPORT_PROVIDER_TIMEOUT' });

    const oversized = client({
      fetchImplementation: vi.fn<typeof fetch>().mockResolvedValue(
        new Response('{}', {
          status: 200,
          headers: { 'content-length': String(8 * 1024 * 1024) },
        }),
      ),
      maxAttempts: 1,
    });
    await expect(
      oversized.listDialogs({ phoneDigits: '79990000001', correlationId: 'correlation-1' }),
    ).rejects.toMatchObject({ code: 'SUPPORT_PROVIDER_INVALID_RESPONSE' });
  });

  it('refuses an insecure provider base URL outside localhost', () => {
    expect(
      () =>
        new LegacyStationSupportClient({
          baseUrl: 'http://support.padlhub.test/lk/support',
          timeoutMs: 1_000,
          maxAttempts: 1,
          circuitFailureThreshold: 3,
          circuitResetMs: 1_000,
        }),
    ).toThrow('SUPPORT_LEGACY_BASE_URL_INVALID');
  });

  it('normalizes the phone forms the provider accepts', () => {
    expect(normalizeSupportPhoneDigits('+7 999 000-00-01')).toBe('79990000001');
    expect(normalizeSupportPhoneDigits('89990000001')).toBe('79990000001');
    expect(normalizeSupportPhoneDigits('9990000001')).toBe('79990000001');
    expect(normalizeSupportPhoneDigits('123')).toBeNull();
    expect(normalizeSupportPhoneDigits('+49 151 12345678')).toBeNull();
    expect(normalizeSupportPhoneDigits(null)).toBeNull();
  });
});
