import { useEffect, useState } from 'react';
import type { GameCreateScheduleQuote, GameCreateScheduleSlot } from '@phub/api-sdk';
import { GameCreateWizardHeader, GameCreateWizardNext } from './GameCreateWizard.js';
import { useGameCreateWizard } from './use-game-create-wizard.js';
import './GameCreateScheduleWizard.css';

const TIME_ZONE = 'Europe/Moscow';
const DAY = new Intl.DateTimeFormat('sv-SE', { timeZone: TIME_ZONE });
const DATE_LABEL = new Intl.DateTimeFormat('ru-RU', {
  timeZone: TIME_ZONE,
  weekday: 'short',
  day: 'numeric',
  month: 'short',
});
const TIME_LABEL = new Intl.DateTimeFormat('ru-RU', {
  timeZone: TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
});
const RUBLES = new Intl.NumberFormat('ru-RU', {
  style: 'currency',
  currency: 'RUB',
  minimumFractionDigits: 0,
});

export interface GameCreateScheduleSource {
  readonly listSlots: (input: {
    readonly stationId: string;
    readonly day: string;
    readonly durationMinutes: 60 | 90 | 120;
    readonly signal: AbortSignal;
  }) => Promise<readonly GameCreateScheduleSlot[]>;
  readonly readQuote: (input: {
    readonly stationId: string;
    readonly day: string;
    readonly durationMinutes: 60 | 90 | 120;
    readonly slotId: string;
    readonly signal: AbortSignal;
  }) => Promise<GameCreateScheduleQuote>;
}

type Station = { readonly id: string; readonly title: string; readonly city?: string | null };
type ReadResult<T> =
  { readonly key: string; readonly value: T } | { readonly key: string; readonly error: string };

function failureCode(error: unknown) {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : 'UNKNOWN';
}

const price = (amount: number | null) =>
  amount === null ? 'Цена уточняется' : RUBLES.format(amount / 100);

function slotTime(slot: GameCreateScheduleSlot) {
  return `${TIME_LABEL.format(new Date(slot.startsAt))}–${TIME_LABEL.format(new Date(slot.endsAt))}`;
}

export function GameCreateScheduleWizard({
  stations,
  source,
  gamesHref = '/games',
  today = DAY.format(new Date()),
}: {
  readonly stations: readonly Station[];
  readonly source: GameCreateScheduleSource;
  readonly gamesHref?: string;
  readonly today?: string;
}) {
  const wizard = useGameCreateWizard();
  const [stationId, setStation] = useState(stations[0]?.id ?? '');
  const [day, setDay] = useState(today);
  const [duration, setDuration] = useState<60 | 90 | 120>(60);
  const [court, setCourt] = useState('');
  const [slotId, setSlot] = useState('');
  const [retry, setRetry] = useState(0);
  const [quoteVersion, setQuoteVersion] = useState(0);
  const [expiredQuoteKey, setExpiredQuoteKey] = useState<string>();
  const [slotsRead, setSlotsRead] = useState<ReadResult<readonly GameCreateScheduleSlot[]>>();
  const [quoteRead, setQuoteRead] = useState<ReadResult<GameCreateScheduleQuote>>();
  const station = stations.find((item) => item.id === stationId);
  const scheduleKey = JSON.stringify([stationId, day, duration, retry]);
  const currentSchedule = slotsRead?.key === scheduleKey ? slotsRead : undefined;
  const slots = currentSchedule && 'value' in currentSchedule ? currentSchedule.value : [];
  const courts = new Map(slots.map(({ courtKey, courtName }) => [courtKey, courtName]));
  const selected = slots.find((slot) => slot.id === slotId && slot.courtKey === court);
  const quoteKey = JSON.stringify([scheduleKey, selected?.id, quoteVersion]);
  const quote = quoteRead?.key === quoteKey ? quoteRead : undefined;
  const quoteExpired = expiredQuoteKey === quoteKey;
  const days = Array.from({ length: 14 }, (_, offset) => {
    const date = new Date(Date.parse(today + 'T12:00:00+03:00') + offset * 86_400_000);
    return { day: DAY.format(date), label: DATE_LABEL.format(date) };
  });

  useEffect(() => {
    if (!stationId || wizard.step === 0 || currentSchedule) return;
    const controller = new AbortController();
    void source
      .listSlots({ stationId, day, durationMinutes: duration, signal: controller.signal })
      .then(
        (value) => {
          if (!controller.signal.aborted) setSlotsRead({ key: scheduleKey, value });
        },
        (error: unknown) => {
          if (!controller.signal.aborted)
            setSlotsRead({ key: scheduleKey, error: failureCode(error) });
        },
      );
    return () => controller.abort();
  }, [source, stationId, day, duration, scheduleKey, currentSchedule, wizard.step]);

  useEffect(() => {
    if (!selected || wizard.step !== 2) return;
    const controller = new AbortController();
    void source
      .readQuote({
        stationId,
        day,
        durationMinutes: duration,
        slotId: selected.id,
        signal: controller.signal,
      })
      .then(
        (value) => {
          if (!controller.signal.aborted) setQuoteRead({ key: quoteKey, value });
        },
        (error: unknown) => {
          if (!controller.signal.aborted)
            setQuoteRead({ key: quoteKey, error: failureCode(error) });
        },
      );
    return () => controller.abort();
  }, [source, stationId, day, duration, selected, quoteKey, wizard.step]);

  useEffect(() => {
    if (!quote || !('value' in quote)) return;
    const delay = Math.max(0, Date.parse(quote.value.expiresAt) - Date.now());
    const expiry = window.setTimeout(() => setExpiredQuoteKey(quote.key), delay);
    return () => window.clearTimeout(expiry);
  }, [quote]);

  function resetSlot() {
    setCourt('');
    setSlot('');
  }

  const summary =
    selected && station ? (
      <aside className="game-schedule-summary" aria-label="Выбранная игра">
        <strong>{station.title}</strong>
        <span>{selected.courtName}</span>
        <span>
          {DATE_LABEL.format(new Date(selected.startsAt))} · {slotTime(selected)} МСК
        </span>
        <span>{duration} мин</span>
      </aside>
    ) : null;

  return (
    <main className="games-page games-page--create game-schedule-wizard">
      <GameCreateWizardHeader
        title="Создать игру"
        step={wizard.step}
        label={(['Где играем', 'Корт и время', 'Цена и условия'] as const)[wizard.step]}
        href={gamesHref}
        busy={false}
        back={wizard.back}
      />
      <div className="game-schedule-layout">
        <section className="game-schedule-content" aria-label="Параметры игры">
          {wizard.step === 0 ? (
            <>
              <div className="game-schedule-choices" role="group" aria-label="Станции">
                {stations.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    aria-pressed={item.id === stationId}
                    onClick={() => {
                      if (item.id === stationId) return;
                      setStation(item.id);
                      resetSlot();
                    }}
                  >
                    <strong>{item.title}</strong>
                    {item.city ? <small>{item.city}</small> : null}
                  </button>
                ))}
              </div>
              {stations.length ? null : <p role="status">Станции для бронирования недоступны.</p>}
              <GameCreateWizardNext disabled={!station} onClick={() => wizard.advance(1)} />
            </>
          ) : null}
          {wizard.step === 1 ? (
            <>
              <div className="game-schedule-days" role="group" aria-label="Дата игры">
                {days.map((item) => (
                  <button
                    key={item.day}
                    type="button"
                    aria-pressed={day === item.day}
                    onClick={() => {
                      if (day === item.day) return;
                      setDay(item.day);
                      resetSlot();
                    }}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
              <div className="game-schedule-durations" role="group" aria-label="Продолжительность">
                {([60, 90, 120] as const).map((minutes) => (
                  <button
                    type="button"
                    key={minutes}
                    aria-pressed={minutes === duration}
                    onClick={() => {
                      if (minutes === duration) return;
                      setDuration(minutes);
                      resetSlot();
                    }}
                  >
                    {minutes} мин
                  </button>
                ))}
              </div>
              {!currentSchedule ? <p role="status">Загружаем свободные слоты…</p> : null}
              {currentSchedule && 'error' in currentSchedule ? (
                <div className="game-schedule-message">
                  <p role="alert">
                    {currentSchedule.error === 'GAME_CREATE_SCHEDULE_STATION_UNAVAILABLE'
                      ? 'Станция пока не подключена к расписанию ЛК1.'
                      : currentSchedule.error === 'VIVA_REAUTH_REQUIRED'
                        ? 'Для расписания нужен действующий вход через Viva.'
                        : 'Не удалось загрузить расписание.'}
                  </p>
                  <button type="button" onClick={() => setRetry((value) => value + 1)}>
                    Повторить
                  </button>
                </div>
              ) : null}
              {currentSchedule && 'value' in currentSchedule && !slots.length ? (
                <p role="status">Свободных слотов нет. Выберите другую дату или длительность.</p>
              ) : null}
              {courts.size ? (
                <div className="game-schedule-choices" role="group" aria-label="Корты">
                  {[...courts].map(([id, name]) => (
                    <button
                      key={id}
                      type="button"
                      aria-pressed={court === id}
                      onClick={() => {
                        if (court === id) return;
                        setCourt(id);
                        setSlot('');
                      }}
                    >
                      {name}
                    </button>
                  ))}
                </div>
              ) : null}
              {court ? (
                <div className="game-schedule-choices" role="group" aria-label="Свободные слоты">
                  {slots
                    .filter((item) => item.courtKey === court)
                    .map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        aria-pressed={slotId === item.id}
                        onClick={() => setSlot(item.id)}
                      >
                        <strong>{slotTime(item)}</strong>
                        {item.amountMinor !== null ? (
                          <small>{price(item.amountMinor)}</small>
                        ) : null}
                      </button>
                    ))}
                </div>
              ) : null}
              <GameCreateWizardNext
                disabled={!selected}
                onClick={() => {
                  setQuoteVersion((value) => value + 1);
                  wizard.advance(2);
                }}
              />
            </>
          ) : null}
          {wizard.step === 2 ? (
            <>
              {!selected ? <p role="status">Выберите свободное время на предыдущем шаге.</p> : null}
              {selected && !quote ? <p role="status">Загружаем цену и условия…</p> : null}
              {quote && 'error' in quote ? (
                <div className="game-schedule-message">
                  <p role="alert">
                    {quote.error === 'GAME_CREATE_SCHEDULE_SLOT_CHANGED'
                      ? 'Этот слот больше недоступен.'
                      : 'Не удалось подтвердить цену ЛК1.'}
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      resetSlot();
                      setRetry((value) => value + 1);
                      wizard.back();
                    }}
                  >
                    Обновить расписание
                  </button>
                </div>
              ) : null}
              {quoteExpired ? (
                <div className="game-schedule-message">
                  <p role="status">Цена устарела.</p>
                  <button type="button" onClick={() => setQuoteVersion((value) => value + 1)}>
                    Обновить цену
                  </button>
                </div>
              ) : null}
              {quote && 'value' in quote && !quoteExpired ? (
                <>
                  <dl className="game-schedule-prices">
                    <div>
                      <dt>Весь корт</dt>
                      <dd>{price(quote.value.wholeCourtMinor)}</dd>
                    </div>
                    <div>
                      <dt>Моя доля в игре 2×2</dt>
                      <dd>{price(quote.value.shareMinor)}</dd>
                    </div>
                    <div>
                      <dt>С Резидентством</dt>
                      <dd>
                        {quote.value.residency.status === 'APPLIED'
                          ? price(quote.value.residency.amountMinor)
                          : quote.value.residency.status === 'NOT_APPLICABLE'
                            ? 'Не применяется'
                            : 'Условия не подтверждены'}
                      </dd>
                    </div>
                  </dl>
                  <p>
                    Резидентство применяется к личной доле. При оплате всего корта льгота не
                    действует.
                  </p>
                  <p>ЛК1 подтверждает цену и доступность при оформлении.</p>
                </>
              ) : null}
            </>
          ) : null}
        </section>
        {summary}
      </div>
    </main>
  );
}
