import { describe, expect, it, vi } from 'vitest';
import {
  VivaCreateLocationSource,
  CreateLocationProviderContradiction,
} from './create-location-source.js';
const input = {
  providerTenantKey: 'iSkq6G' as const,
  studioId: 'synthetic-studio',
  roomId: 'synthetic-room',
  accessToken: 'synthetic-token-with-no-authority',
  correlationId: 'synthetic-correlation',
};
const url = 'https://api.vivacrm.ru/api/v1/studios/synthetic-studio/rooms/synthetic-room';
function response(body: unknown, status = 200, origin = url) {
  const r = new Response(JSON.stringify(body), { status });
  Object.defineProperty(r, 'url', { value: origin });
  return r;
}
describe('CREATE room studio source', () => {
  it('uses exact fixed GET origin, bearer, timeout and redirect refusal', async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(response({ id: input.roomId }));
    expect(
      await new VivaCreateLocationSource({ fetchImplementation, now: () => 0 }).readRoomStudio(
        input,
      ),
    ).toEqual({
      roomId: input.roomId,
      studioId: input.studioId,
      observedAt: '1970-01-01T00:00:00.000Z',
    });
    expect(fetchImplementation).toHaveBeenCalledWith(
      url,
      expect.objectContaining({
        method: 'GET',
        redirect: 'error',
        signal: expect.any(AbortSignal) as AbortSignal,
        headers: {
          Authorization: `Bearer ${input.accessToken}`,
          'X-Correlation-ID': input.correlationId,
        },
      }),
    );
  });
  it.each([
    { id: 'wrong' },
    { id: input.roomId, roomId: 'wrong' },
    { id: input.roomId, studioId: 'wrong' },
  ])('rejects contradictory response %j', async (body) => {
    const source = new VivaCreateLocationSource({
      fetchImplementation: vi.fn().mockResolvedValue(response(body)),
    });
    await expect(source.readRoomStudio(input)).rejects.toBeInstanceOf(
      CreateLocationProviderContradiction,
    );
  });
  it.each([201, 404, 401])('rejects status %s', async (status) => {
    await expect(
      new VivaCreateLocationSource({
        fetchImplementation: vi.fn().mockResolvedValue(response({ id: input.roomId }, status)),
      }).readRoomStudio(input),
    ).rejects.toThrow('UNAVAILABLE');
  });
  it('rejects other response origin and never follows redirects', async () => {
    await expect(
      new VivaCreateLocationSource({
        fetchImplementation: vi
          .fn()
          .mockResolvedValue(response({ id: input.roomId }, 200, 'https://example.invalid/')),
      }).readRoomStudio(input),
    ).rejects.toThrow('UNAVAILABLE');
  });
  it('bounded retry handles 503 then valid response', async () => {
    const fetchImplementation = vi
      .fn()
      .mockResolvedValueOnce(response({}, 503))
      .mockResolvedValueOnce(response({ roomId: input.roomId }));
    await new VivaCreateLocationSource({ fetchImplementation }).readRoomStudio(input);
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });
  it('opens circuit after three failures without a fourth call', async () => {
    const fetchImplementation = vi.fn().mockRejectedValue(new Error('timeout'));
    const source = new VivaCreateLocationSource({ fetchImplementation });
    for (let i = 0; i < 3; i++)
      await expect(source.readRoomStudio(input)).rejects.toThrow('UNAVAILABLE');
    await expect(source.readRoomStudio(input)).rejects.toThrow('CIRCUIT_OPEN');
    expect(fetchImplementation).toHaveBeenCalledTimes(3);
  });
  it('rejects oversized responses and unsafe path or header input', async () => {
    const fetchImplementation = vi
      .fn()
      .mockResolvedValue(response({ id: input.roomId, padding: 'a'.repeat(65536) }));
    const source = new VivaCreateLocationSource({ fetchImplementation });
    await expect(source.readRoomStudio(input)).rejects.toThrow('UNAVAILABLE');
    for (const changed of [
      { roomId: '../room' },
      { studioId: 'studio\n' },
      { accessToken: 'bad\r\nheader' },
      { providerTenantKey: 'foreign' },
    ])
      await expect(source.readRoomStudio({ ...input, ...changed } as typeof input)).rejects.toThrow(
        'INPUT_INVALID',
      );
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });
});
