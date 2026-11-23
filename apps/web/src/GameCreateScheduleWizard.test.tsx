// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GameCreateScheduleWizard,
  type GameCreateScheduleSource,
} from './GameCreateScheduleWizard.js';

const stations = [{ id: 'station', title: 'Селигерская' }];
const slot = {
  id: 'a'.repeat(64),
  courtKey: 'b'.repeat(64),
  courtName: 'Корт №1',
  startsAt: '2026-12-06T12:00:00+03:00',
  endsAt: '2026-12-06T13:00:00+03:00',
  amountMinor: null,
};
function quoteTimes() {
  return {
    currency: 'RUB' as const,
    observedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 25_000).toISOString(),
  };
}
const renderWizard = (source: GameCreateScheduleSource) =>
  render(<GameCreateScheduleWizard stations={stations} source={source} today="2026-12-06" />);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState({}, '', '/games/new?view=schedule');
});

describe('game creation schedule', () => {
  it.each([true, false])(
    'keeps the same flow and preserves a choice on Back (mobile media query %s)',
    async (matches) => {
      vi.stubGlobal(
        'matchMedia',
        vi.fn(() => ({
          matches,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        })),
      );
      const listSlots = vi.fn<GameCreateScheduleSource['listSlots']>().mockResolvedValue([slot]);
      const readQuote = vi.fn<GameCreateScheduleSource['readQuote']>().mockResolvedValue({
        wholeCourtMinor: 400000,
        shareMinor: 100000,
        ...quoteTimes(),
        residency: { status: 'APPLIED', amountMinor: 70000 },
      });
      renderWizard({ listSlots, readQuote });
      const user = userEvent.setup();
      expect(screen.getByRole('heading', { name: 'Где играем' })).toBeTruthy();
      await user.click(screen.getByRole('button', { name: 'Продолжить' }));
      expect(screen.getByRole('heading', { name: 'Корт и время' })).toBeTruthy();
      expect(listSlots).toHaveBeenCalledTimes(1);
      expect(readQuote).toHaveBeenCalledTimes(0);
      await user.click(await screen.findByRole('button', { name: 'Корт №1' }));
      await user.click(screen.getByRole('button', { name: '12:00–13:00' }));
      await user.click(screen.getByRole('button', { name: 'Продолжить' }));
      expect(await screen.findByText('С Резидентством')).toBeTruthy();
      expect(screen.getByText(/700\s*₽/)).toBeTruthy();
      expect(readQuote.mock.calls[0]?.[0]).toMatchObject({
        stationId: 'station',
        day: '2026-12-06',
        durationMinutes: 60,
        slotId: slot.id,
      });
      expect(readQuote.mock.calls[0]?.[0].signal).toBeInstanceOf(AbortSignal);
      await user.click(screen.getByRole('button', { name: 'Назад' }));
      const choices = await screen.findByRole('group', { name: 'Свободные слоты' });
      expect(
        within(choices).getByRole('button', { name: '12:00–13:00' }).getAttribute('aria-pressed'),
      ).toBe('true');
      await user.click(screen.getByRole('button', { name: '90 мин' }));
      expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Продолжить' }).disabled).toBe(
        true,
      );
      expect(readQuote).toHaveBeenCalledTimes(1);
    },
  );

  it('reports missing residency evidence independently from the base price', async () => {
    renderWizard({
      listSlots: () => Promise.resolve([slot]),
      readQuote: () =>
        Promise.resolve({
          wholeCourtMinor: 400000,
          shareMinor: 100000,
          ...quoteTimes(),
          residency: { status: 'UNAVAILABLE' },
        }),
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Продолжить' }));
    await user.click(await screen.findByRole('button', { name: 'Корт №1' }));
    await user.click(screen.getByRole('button', { name: '12:00–13:00' }));
    await user.click(screen.getByRole('button', { name: 'Продолжить' }));
    expect(await screen.findByText('Условия не подтверждены')).toBeTruthy();
    expect(screen.queryByText('Не применяется')).toBeNull();
  });

  it('replaces an expired quote only after a new read of the same slot', async () => {
    const quote = {
      ...quoteTimes(),
      wholeCourtMinor: 400000,
      shareMinor: 100000,
      residency: { status: 'NOT_APPLICABLE' as const },
    };
    const readQuote = vi
      .fn<GameCreateScheduleSource['readQuote']>()
      .mockResolvedValueOnce({ ...quote, expiresAt: new Date(Date.now() - 1).toISOString() })
      .mockResolvedValueOnce(quote);
    renderWizard({ listSlots: () => Promise.resolve([slot]), readQuote });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Продолжить' }));
    await user.click(await screen.findByRole('button', { name: 'Корт №1' }));
    await user.click(screen.getByRole('button', { name: '12:00–13:00' }));
    await user.click(screen.getByRole('button', { name: 'Продолжить' }));
    await user.click(await screen.findByRole('button', { name: 'Обновить цену' }));
    expect(await screen.findByText('Весь корт')).toBeTruthy();
    expect(readQuote.mock.calls.map(([input]) => input.slotId)).toEqual([slot.id, slot.id]);
  });
});
