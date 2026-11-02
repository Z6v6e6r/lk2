import { describe, it, expect, vi } from 'vitest';
import type { GameCard } from '@phub/api-sdk';
import { cancelGameAndRead } from './game-cancel-readback.js';
const id = '751fe6a8-b0b1-4b2b-873d-a2d785c4e191';
const observed = (displayState: string) => ({ id, displayState }) as GameCard;
describe('local CANCEL authoritative readback', () => {
  it.each(['CANCELLED', 'FINDING_PLAYERS'])(
    'reads after lost ACK, never issues another command: %s',
    async (state) => {
      const cancel = vi.fn().mockRejectedValue(new TypeError('lost response'));
      const read = vi.fn().mockResolvedValue(observed(state));
      expect(await cancelGameAndRead({ gameId: id, cancel, read, isCurrent: () => true })).toEqual(
        observed(state),
      );
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(read).toHaveBeenCalledWith(id);
    },
  );
  it('keeps unavailable readback unresolved', async () => {
    expect(
      await cancelGameAndRead({
        gameId: id,
        cancel: vi.fn().mockRejectedValue(new Error()),
        read: vi.fn().mockRejectedValue(new Error()),
        isCurrent: () => true,
      }),
    ).toBeNull();
  });
  it('does not adopt another game or claim success from its ACK', async () => {
    expect(
      await cancelGameAndRead({
        gameId: id,
        cancel: vi.fn().mockResolvedValue({}),
        read: vi.fn().mockResolvedValue({ ...observed('CANCELLED'), id: 'other' }),
        isCurrent: () => true,
      }),
    ).toBeNull();
  });
  it('refuses before command and discards late ACK after principal change', async () => {
    const cancel = vi.fn(),
      read = vi.fn();
    await expect(
      cancelGameAndRead({ gameId: id, cancel, read, isCurrent: () => false }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancel).not.toHaveBeenCalled();
    let current = true;
    cancel.mockImplementation(() => {
      current = false;
      return Promise.resolve({});
    });
    await expect(
      cancelGameAndRead({ gameId: id, cancel, read, isCurrent: () => current }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(read).not.toHaveBeenCalled();
  });
});
