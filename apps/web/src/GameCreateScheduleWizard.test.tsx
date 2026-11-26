// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GameCreateScheduleWizard,
  type GameCreateScheduleSource,
} from './GameCreateScheduleWizard.js';

const stations = [{ id: 'station', title: 'Селигерская' }];
const courtName = 'Корт №1 для игры 2 на 2 (панорамик)';
const slot = {
  id: 'a'.repeat(64),
  courtKey: 'b'.repeat(64),
  courtName,
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
  it('shows court types and opening status from the station catalogue', async () => {
    const listSlots = vi.fn<GameCreateScheduleSource['listSlots']>().mockResolvedValue([]);
    const source = { listSlots, readQuote: vi.fn<GameCreateScheduleSource['readQuote']>() };
    render(
      <GameCreateScheduleWizard
        source={source}
        today="2026-12-06"
        stations={[
          {
            id: 'station',
            title: 'Селигерская',
            city: 'Москва',
            address: 'г. Москва, ул. Ивана Сусанина, 1',
            panoramicCourtsCount: 3,
            singleCourtsCount: 1,
          },
          { id: 'opening', title: 'Котельники', city: 'Москва', isActive: false },
          {
            id: 'total-only',
            title: 'Сочи',
            city: 'Сириус',
            address: 'Краснодарский край, пгт Сириус',
            courtCount: 4,
          },
        ]}
      />,
    );
    const active = screen.getByRole('button', { name: /Селигерская/ });
    expect(within(active).getByText('ул. Ивана Сусанина, 1')).toBeVisible();
    expect(within(active).getByText('панорамик: 3 · сингл: 1')).toBeVisible();
    const sochi = screen.getByRole('button', { name: 'Сочи' });
    expect(within(sochi).getByText('Краснодарский край, пгт Сириус')).toBeVisible();
    expect(within(sochi).getByText('4 корта')).toBeVisible();
    const opening = screen.getByRole('button', { name: /Котельники/ });
    expect(within(opening).getByText('Скоро открытие')).toBeVisible();
    expect(opening).toBeDisabled();
    await userEvent.setup().click(opening);
    expect(listSlots).not.toHaveBeenCalled();
  });

  it('collapses each city independently and reveals search matches', async () => {
    const source = {
      listSlots: vi.fn<GameCreateScheduleSource['listSlots']>(),
      readQuote: vi.fn<GameCreateScheduleSource['readQuote']>(),
    };
    render(
      <GameCreateScheduleWizard
        source={source}
        stations={[
          { id: 'moscow', title: 'Селигерская', city: 'Москва' },
          { id: 'sirius', title: 'Сочи', city: 'Сириус' },
        ]}
      />,
    );
    const user = userEvent.setup();
    expect(screen.queryByRole('heading', { name: 'Станции по городам' })).not.toBeInTheDocument();
    const moscow = screen.getByRole('button', { name: 'Москва' });
    const sirius = screen.getByRole('button', { name: 'Сириус' });
    expect(screen.getByRole('button', { name: 'Селигерская' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Сочи' })).toBeVisible();
    await user.click(moscow);
    expect(moscow).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: 'Селигерская' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Сочи' })).toBeVisible();

    expect(sirius).toHaveAttribute('aria-expanded', 'true');
    await user.click(moscow);
    expect(moscow).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: 'Селигерская' })).toBeVisible();

    await user.click(moscow);
    await user.type(screen.getByRole('searchbox', { name: 'Найти клуб' }), 'Сели');
    expect(screen.getByRole('heading', { name: 'Результаты поиска' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Селигерская' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Сочи' })).not.toBeInTheDocument();
  });

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
      expect(screen.getByRole('heading', { name: 'Выберите клуб' })).toBeTruthy();
      await user.click(screen.getByRole('button', { name: 'Селигерская' }));
      expect(screen.getByRole('heading', { name: 'Дата и время' })).toBeTruthy();
      expect(listSlots).toHaveBeenCalledTimes(1);
      expect(readQuote).toHaveBeenCalledTimes(0);
      await user.click(await screen.findByRole('button', { name: 'Корт №1' }));
      await user.click(screen.getByRole('button', { name: '12:00–13:00' }));
      const payers = within(screen.getByRole('group', { name: 'Кто оплачивает корт?' }));
      expect(payers.getByRole('radio', { name: /Каждый за себя/ })).toBeChecked();
      expect(await payers.findByText(/700\s*₽/)).toBeTruthy();
      expect(payers.queryByText('По подписке')).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Показать 1 вариант' }));
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

  it('updates the header summary and displays quoted zero-price subscription', async () => {
    renderWizard({
      listSlots: () => Promise.resolve([slot]),
      readQuote: () =>
        Promise.resolve({
          ...quoteTimes(),
          wholeCourtMinor: 240000,
          shareMinor: 60000,
          subscriptionMinor: 0,
          residency: { status: 'APPLIED', amountMinor: 48000 },
        }),
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Селигерская' }));
    const summary = () => within(screen.getByRole('region', { name: 'Выбранная игра' }));
    expect(summary().getByText('Селигерская')).toBeVisible();
    expect(summary().getByText('6 дек · 60 мин')).toBeVisible();
    await user.click(await screen.findByRole('button', { name: '12:00–13:00' }));
    expect(summary().getByText('6 дек · 12:00–13:00')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Корт №1' }));
    expect(summary().getByText('Селигерская · Корт №1')).toBeVisible();
    const payers = within(screen.getByRole('group', { name: 'Кто оплачивает корт?' }));
    expect(await payers.findByText('По подписке')).toHaveTextContent(/По подписке\s+0\s*₽/);
    expect(payers.getByText('С резидентством')).toHaveTextContent(/С резидентством\s+480\s*₽/);
    await user.click(payers.getByRole('radio', { name: /^Весь корт/ }));
    expect(summary().getByText('Я оплачиваю весь корт')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Показать 1 вариант' }));
    expect(summary().getByText('Приватная')).toBeVisible();
    expect(summary().getByText('D – C')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'B' }));
    await user.click(screen.getByRole('radio', { name: /Открытая игра/ }));
    expect(summary().getByText('D – B')).toBeVisible();
    expect(summary().getByText('Открытая')).toBeVisible();
    await user.click(summary().getByRole('button', { name: 'Изменить' }));
    expect(await screen.findByRole('heading', { name: 'Дата и время' })).toBeVisible();
    expect(summary().getByText('Селигерская · Корт №1')).toBeVisible();
    expect(summary().getByText('D – B')).toBeVisible();
    expect(summary().getByText('Открытая')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Сбросить выбранное время' }));
    expect(summary().getByText('6 дек · 60 мин')).toBeVisible();
  });

  it('filters courts and times by format and only quotes doubles', async () => {
    const singles = {
      ...slot,
      id: 'c'.repeat(64),
      courtKey: 'd'.repeat(64),
      courtName: 'Корт №4 для игры 1 на 1 (сингл)',
      startsAt: '2026-12-06T16:00:00+03:00',
      endsAt: '2026-12-06T17:00:00+03:00',
    };
    const listSlots = vi
      .fn<GameCreateScheduleSource['listSlots']>()
      .mockResolvedValue([slot, singles]);
    const readQuote = vi.fn<GameCreateScheduleSource['readQuote']>().mockResolvedValue({
      ...quoteTimes(),
      wholeCourtMinor: 400000,
      shareMinor: 100000,
      residency: { status: 'NOT_APPLICABLE' },
    });
    renderWizard({ listSlots, readQuote });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Селигерская' }));
    const formats = within(screen.getByRole('group', { name: 'Формат игры' }));
    const doublesButton = formats.getByRole('button', { name: '2 на 2' });
    const singlesButton = formats.getByRole('button', { name: '1 на 1' });
    expect(doublesButton).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('button', { name: 'Корт №4' })).not.toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Корт №1' }));
    await user.click(screen.getByRole('button', { name: '12:00–13:00' }));
    expect(readQuote).toHaveBeenCalledOnce();

    await user.click(singlesButton);
    expect(singlesButton).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('button', { name: 'Корт №1' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '12:00–13:00' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Корт №4' }));
    await user.click(screen.getByRole('button', { name: '16:00–17:00' }));
    expect(screen.getByRole('button', { name: '16:00–17:00' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByText('Запись на игру 1 на 1 пока недоступна.')).toBeVisible();
    expect(screen.queryByRole('group', { name: 'Кто оплачивает корт?' })).not.toBeInTheDocument();
    expect(readQuote).toHaveBeenCalledOnce();
    expect(listSlots).toHaveBeenCalledOnce();

    await user.click(doublesButton);
    expect(screen.getByRole('button', { name: 'Продолжить' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Корт №1' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('shows the next 14 days alongside today and allows an overnight slot across the month boundary', async () => {
    const overnight = {
      ...slot,
      startsAt: '2026-12-01T23:00:00+03:00',
      endsAt: '2026-12-02T01:00:00+03:00',
    };
    const listSlots = vi.fn<GameCreateScheduleSource['listSlots']>().mockResolvedValue([overnight]);
    const readQuote = vi.fn<GameCreateScheduleSource['readQuote']>().mockResolvedValue({
      ...quoteTimes(),
      wholeCourtMinor: null,
      shareMinor: null,
      residency: { status: 'UNAVAILABLE' },
    });
    render(
      <GameCreateScheduleWizard
        stations={stations}
        source={{ listSlots, readQuote }}
        today="2026-11-26"
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Селигерская' }));
    const calendar = within(screen.getByRole('group', { name: 'Дата игры' }));
    const dates = calendar.getAllByRole('button');
    expect(dates).toHaveLength(15);
    expect(dates[0]).toHaveAccessibleName(/26 нояб/);
    expect(dates.at(-1)).toHaveAccessibleName(/10 дек/);
    expect(calendar.queryByRole('button', { name: /25 нояб/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Месяц' })).not.toBeInTheDocument();
    const november = within(calendar.getByRole('group', { name: 'ноябрь' }));
    expect(november.getByRole('button', { name: /30 нояб/ })).toBeVisible();
    const december = within(calendar.getByRole('group', { name: 'декабрь' }));
    expect(listSlots).toHaveBeenCalledOnce();
    await user.click(december.getByRole('button', { name: /1 дек/ }));
    expect(listSlots).toHaveBeenLastCalledWith(expect.objectContaining({ day: '2026-12-01' }));

    const time = await screen.findByRole('button', {
      name: '23:00–01:00, окончание на следующий день',
    });
    expect(time).toHaveTextContent(/^23:00$/);
    await user.click(time);
    const courtButton = screen.getByRole('button', { name: 'Корт №1' });
    expect(within(courtButton).getByText('Панорамик')).toBeVisible();
    await user.click(courtButton);
    const continueButton = screen.getByRole('button', { name: 'Показать 1 вариант' });
    expect(continueButton).toHaveTextContent('1 дек · 23:00–01:00 (след. день) · Корт №1');
    await user.click(screen.getByRole('button', { name: 'Сбросить выбранный корт' }));
    expect(time).toHaveAttribute('aria-pressed', 'true');
    expect(courtButton).toHaveAttribute('aria-pressed', 'false');
    await user.click(courtButton);
    await user.click(screen.getByRole('button', { name: 'Сбросить выбранное время' }));
    expect(time).toHaveAttribute('aria-pressed', 'false');
    expect(courtButton).toHaveAttribute('aria-pressed', 'true');
  });

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
    await user.click(screen.getByRole('button', { name: 'Показать 1 вариант' }));
    expect(await screen.findByText('ЛК1 не подтвердил условия')).toBeTruthy();
    expect(screen.queryByText('Не применяется')).toBeNull();
  });

  it('keeps an in-flight quote on Continue and Back, then retries the same slot after a rate limit', async () => {
    let rejectQuote!: (cause: Error) => void;
    const pending = new Promise<never>((_, reject) => {
      rejectQuote = reject;
    });
    const listSlots = vi.fn<GameCreateScheduleSource['listSlots']>().mockResolvedValue([slot]);
    const readQuote = vi
      .fn<GameCreateScheduleSource['readQuote']>()
      .mockReturnValueOnce(pending)
      .mockImplementation(() =>
        Promise.resolve({
          ...quoteTimes(),
          wholeCourtMinor: 400000,
          shareMinor: 100000,
          residency: { status: 'NOT_APPLICABLE' },
        }),
      );
    renderWizard({ listSlots, readQuote });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Селигерская' }));
    await user.click(await screen.findByRole('button', { name: 'Корт №1' }));
    await user.click(screen.getByRole('button', { name: '12:00–13:00' }));
    await user.click(screen.getByRole('button', { name: 'Показать 1 вариант' }));
    await user.click(screen.getByRole('button', { name: 'Изменить' }));
    await user.click(screen.getByRole('button', { name: 'Показать 1 вариант' }));

    expect(readQuote).toHaveBeenCalledOnce();
    expect(readQuote.mock.calls[0]?.[0].signal.aborted).toBe(false);
    rejectQuote(Object.assign(new Error(), { code: 'GAME_CREATE_SCHEDULE_RATE_LIMITED' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Слишком много запросов цены');
    expect(screen.getByRole('button', { name: 'Записаться' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Обновить цену' }));
    expect(await screen.findByText(/^1\s*000\s*₽$/)).toBeVisible();
    expect(readQuote.mock.calls.map(([input]) => input.slotId)).toEqual([slot.id, slot.id]);
    expect(listSlots).toHaveBeenCalledOnce();
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
      await user.click(screen.getByRole('radio', { name: /^Весь корт/ }));
      await user.click(screen.getByRole('button', { name: 'Показать 1 вариант' }));
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
    await user.click(screen.getByRole('button', { name: 'Показать 1 вариант' }));
    await user.click(await screen.findByRole('button', { name: 'Обновить цену' }));
    expect(await screen.findByText('Разовое участие')).toBeTruthy();
    expect(readQuote.mock.calls.map(([input]) => input.slotId)).toEqual([slot.id, slot.id]);
  });
});
