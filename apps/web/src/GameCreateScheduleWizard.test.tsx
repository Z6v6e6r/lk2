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
      expect(screen.getByRole('heading', { name: 'Выберите место' })).toBeTruthy();
      await user.click(screen.getByRole('button', { name: 'Селигерская' }));
      expect(screen.getByRole('heading', { name: 'Дата и время' })).toBeTruthy();
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
      await user.click(screen.getByRole('button', { name: 'Изменить' }));
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
    await user.click(screen.getByRole('button', { name: 'Селигерская' }));
    await user.click(await screen.findByRole('button', { name: 'Корт №1' }));
    await user.click(screen.getByRole('button', { name: '12:00–13:00' }));
    await user.click(screen.getByRole('button', { name: 'Продолжить' }));
    expect(await screen.findByText('ЛК1 не подтвердил условия')).toBeTruthy();
    expect(screen.queryByText('Не применяется')).toBeNull();
  });

  it.each(['amount', 'court', 'time', 'price-unavailable'] as const)(
    'does not offer checkout for a quote or slot that differs from the approved offer (%s)',
    async (mismatch) => {
      const start = vi.fn();
      render(
        <GameCreateScheduleWizard
          stations={stations}
          today="2026-12-06"
          source={{
            listSlots: () => Promise.resolve([{ ...slot, checkoutCourtId: 'court' }]),
            readQuote: () =>
              Promise.resolve({
                ...quoteTimes(),
                wholeCourtMinor: mismatch === 'price-unavailable' ? null : 400000,
                shareMinor: mismatch === 'price-unavailable' ? null : 100000,
                residency: {
                  status: mismatch === 'price-unavailable' ? 'ACTIVE_UNQUOTED' : 'NOT_APPLICABLE',
                },
              }),
          }}
          checkout={{
            busy: false,
            error: null,
            start,
            offer: {
              stationId: stations[0]!.id,
              courtId: mismatch === 'court' ? 'other-court' : 'court',
              startsAt: mismatch === 'time' ? '2026-12-06T13:00:00+03:00' : slot.startsAt,
              endsAt: slot.endsAt,
              amountMinor: mismatch === 'amount' ? 420000 : 400000,
              currency: 'RUB',
            },
          }}
        />,
      );
      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: 'Селигерская' }));
      await user.click(await screen.findByRole('button', { name: 'Корт №1' }));
      await user.click(screen.getByRole('button', { name: '12:00–13:00' }));
      await user.click(screen.getByRole('radio', { name: /Плачу за всех/ }));
      await user.click(screen.getByRole('button', { name: 'Продолжить' }));
      expect(await screen.findByText('Оплата выбранного слота сейчас недоступна.')).toBeTruthy();
      if (mismatch === 'price-unavailable') {
        expect(screen.getByText('ЛК1 не вернул цену корта для выбранного времени.')).toBeTruthy();
      }
      expect(screen.getByRole<HTMLButtonElement>('button', { name: /Записаться/ }).disabled).toBe(
        true,
      );
      expect(start).not.toHaveBeenCalled();
    },
  );

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
    await user.click(screen.getByRole('button', { name: 'Селигерская' }));
    await user.click(await screen.findByRole('button', { name: 'Корт №1' }));
    await user.click(screen.getByRole('button', { name: '12:00–13:00' }));
    await user.click(screen.getByRole('button', { name: 'Продолжить' }));
    await user.click(await screen.findByRole('button', { name: 'Обновить цену' }));
    expect(await screen.findByText('Разовое участие')).toBeTruthy();
    expect(readQuote.mock.calls.map(([input]) => input.slotId)).toEqual([slot.id, slot.id]);
  });
});
