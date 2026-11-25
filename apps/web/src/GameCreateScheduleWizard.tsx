import { useEffect, useId, useRef, useState } from 'react';
import type {
  GameCreateScheduleQuote,
  GameCreateScheduleSlot,
  WholeCourtCheckoutOffer,
} from '@phub/api-sdk';
import { EventCalendarIcon, EventLocationIcon } from './ActivityCardIcons.js';
import backIconUrl from './assets/game-schedule-back.svg';
import stationChevronUrl from './assets/game-schedule-station-chevron.svg';
import padlHubLogoUrl from './assets/padlhub-logo.svg';
import { locationCourtLabel } from './location-court-label.js';
import { useGameCreateWizard } from './use-game-create-wizard.js';
import { TrainingPeopleIcon } from './TrainingPeopleIcon.js';
import './GameCreateScheduleWizard.css';

const TIME_ZONE = 'Europe/Moscow';
const DAY = new Intl.DateTimeFormat('sv-SE', { timeZone: TIME_ZONE });
const DATE_LABEL = new Intl.DateTimeFormat('ru-RU', {
  timeZone: TIME_ZONE,
  weekday: 'short',
  day: 'numeric',
  month: 'short',
});
const DATE_FULL = new Intl.DateTimeFormat('ru-RU', {
  timeZone: TIME_ZONE,
  day: 'numeric',
  month: 'long',
});
const DATE_CHIP = new Intl.DateTimeFormat('ru-RU', {
  timeZone: TIME_ZONE,
  weekday: 'short',
  month: 'short',
  day: '2-digit',
});
const LEVELS = ['D', 'D+', 'C', 'C+', 'B', 'B+', 'A'] as const;
type Level = (typeof LEVELS)[number];
export interface GameCreateScheduleDetails {
  readonly title: string;
  readonly levelRange: { readonly from: Level; readonly to: Level };
}
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

export interface GameCreateScheduleCheckout {
  readonly offer: WholeCourtCheckoutOffer | null;
  readonly busy: boolean;
  readonly error: string | null;
  readonly start: (
    event: React.MouseEvent<HTMLButtonElement>,
    offer: WholeCourtCheckoutOffer,
    details: GameCreateScheduleDetails,
  ) => void;
}

type Station = {
  readonly id: string;
  readonly title: string;
  readonly city?: string | null;
  readonly address?: string | null;
  readonly latitude?: number | null;
  readonly longitude?: number | null;
  readonly courtCount?: number;
  readonly panoramicCourtsCount?: number | null;
  readonly singleCourtsCount?: number | null;
  readonly outdoorCourtsCount?: number | null;
  readonly isActive?: boolean;
};
type ReadResult<T> =
  { readonly key: string; readonly value: T } | { readonly key: string; readonly error: string };

function failureCode(error: unknown) {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : 'UNKNOWN';
}

const price = (amount: number | null) =>
  amount === null ? 'Цена уточняется' : RUBLES.format(amount / 100);

function stationCourtSummary(station: Station) {
  const { courtCount, panoramicCourtsCount, singleCourtsCount, outdoorCourtsCount } = station;
  const courtTypes = [
    panoramicCourtsCount != null &&
      `Панорамик: ${panoramicCourtsCount} ${locationCourtLabel(panoramicCourtsCount)}`,
    singleCourtsCount != null && `Сингл: ${singleCourtsCount}`,
    outdoorCourtsCount != null && `Открытых кортов: ${outdoorCourtsCount}`,
  ].filter(Boolean);
  if (courtTypes.length) return courtTypes.join(', ');
  return courtCount === undefined ? null : `${courtCount} ${locationCourtLabel(courtCount)}`;
}

function slotTime(slot: GameCreateScheduleSlot) {
  return `${TIME_LABEL.format(new Date(slot.startsAt))}–${TIME_LABEL.format(new Date(slot.endsAt))}`;
}

export function GameCreateScheduleWizard({
  stations,
  source,
  checkout,
  gamesHref = '/games',
  today = DAY.format(new Date()),
}: {
  readonly stations: readonly Station[];
  readonly source: GameCreateScheduleSource;
  readonly checkout?: GameCreateScheduleCheckout;
  readonly gamesHref?: string;
  readonly today?: string;
}) {
  const wizard = useGameCreateWizard();
  const stationDetailsPrefix = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const [stationId, setStation] = useState(stations[0]?.id ?? '');
  const [search, setSearch] = useState('');
  const [showLocations, setShowLocations] = useState(false);
  const [preferredStart, setPreferredStart] = useState('');
  const [payer, setPayer] = useState<'split' | 'self'>('split');
  const [visibility, setVisibility] = useState<'PUBLIC' | 'PRIVATE'>('PUBLIC');
  const [levels, setLevels] = useState<readonly [number, number]>([0, 2]);
  const [title, setTitle] = useState('');
  const [day, setDay] = useState(today);
  const [duration, setDuration] = useState<60 | 90 | 120>(60);
  const [court, setCourt] = useState('');
  const [slotId, setSlot] = useState('');
  const [retry, setRetry] = useState(0);
  const [quoteVersion, setQuoteVersion] = useState(0);
  const [expiredQuoteKey, setExpiredQuoteKey] = useState<string>();
  const [slotsRead, setSlotsRead] = useState<ReadResult<readonly GameCreateScheduleSlot[]>>();
  const [quoteRead, setQuoteRead] = useState<ReadResult<GameCreateScheduleQuote>>();
  const scheduleOpen = wizard.step !== 0;
  const station = stations.find((item) => item.id === stationId);
  const scheduleKey = JSON.stringify([stationId, day, duration, retry]);
  const currentSchedule = slotsRead?.key === scheduleKey ? slotsRead : undefined;
  const slots = currentSchedule && 'value' in currentSchedule ? currentSchedule.value : [];
  const courts = new Map(
    slots
      .filter((slot) => !preferredStart || slot.startsAt === preferredStart)
      .map(({ courtKey, courtName }) => [courtKey, courtName]),
  );
  const selected = slots.find((slot) => slot.id === slotId && slot.courtKey === court);
  const quoteKey = JSON.stringify([scheduleKey, selected?.id, quoteVersion]);
  const quote = quoteRead?.key === quoteKey ? quoteRead : undefined;
  const quoteExpired = expiredQuoteKey === quoteKey;
  const currentQuote = quote && 'value' in quote && !quoteExpired ? quote.value : undefined;
  const times = new Map(
    slots.filter((slot) => !court || slot.courtKey === court).map((slot) => [slot.startsAt, slot]),
  );
  const offer = checkout?.offer;
  const checkoutOffer =
    offer &&
    selected?.checkoutCourtId === offer.courtId &&
    stationId === offer.stationId &&
    Date.parse(selected.startsAt) === Date.parse(offer.startsAt) &&
    Date.parse(selected.endsAt) === Date.parse(offer.endsAt) &&
    currentQuote &&
    currentQuote.wholeCourtMinor === offer.amountMinor &&
    currentQuote.currency === offer.currency
      ? { offer, expiresAt: currentQuote.expiresAt }
      : undefined;
  const days = Array.from({ length: 15 }, (_, offset) => {
    const date = new Date(Date.parse(today + 'T12:00:00+03:00') + offset * 86_400_000);
    const parts = Object.fromEntries(
      DATE_CHIP.formatToParts(date).map((part) => [part.type, part.value]),
    );
    return { day: DAY.format(date), label: DATE_LABEL.format(date), parts };
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
    if (!selected || !scheduleOpen || quote) return;
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
  }, [source, stationId, day, duration, selected, quoteKey, quote, scheduleOpen]);

  useEffect(() => {
    if (!quote || !('value' in quote)) return;
    const delay = Math.max(0, Date.parse(quote.value.expiresAt) - Date.now());
    const expiry = window.setTimeout(() => setExpiredQuoteKey(quote.key), delay);
    return () => window.clearTimeout(expiry);
  }, [quote]);

  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
    if (document.scrollingElement) document.scrollingElement.scrollTop = 0;
  }, [wizard.step]);

  function clearTime() {
    setSlot('');
    setPreferredStart('');
  }

  function resetSlot() {
    setCourt('');
    clearTime();
  }

  function chooseStation(id: string) {
    if (id !== stationId) {
      setStation(id);
      resetSlot();
    }
    wizard.advance(1);
  }

  function chooseCourt(id: string) {
    if (id === court) return;
    const matching =
      !court && slots.find((slot) => slot.courtKey === id && slot.startsAt === preferredStart);
    setCourt(id);
    setSlot(matching ? matching.id : '');
    if (court) setPreferredStart('');
  }

  function choosePayer(value: 'split' | 'self') {
    setPayer(value);
    setVisibility(value === 'self' ? 'PRIVATE' : 'PUBLIC');
  }

  function chooseLevel(index: number) {
    const [from, to] = levels;
    if (index < from) setLevels([index, to]);
    else if (index > to) setLevels([from, index]);
    else if (index === from && from < to) setLevels([from + 1, to]);
    else if (index === to && from < to) setLevels([from, to - 1]);
    else setLevels([from, index]);
  }

  const headerTitle = ['Выберите клуб', 'Дата и время', 'Создание игры'][wizard.step];
  const query = search.trim().toLocaleLowerCase('ru-RU');
  const visibleStations = stations.filter((item) =>
    [item.title, item.city, item.address].some((value) =>
      value?.toLocaleLowerCase('ru-RU').includes(query),
    ),
  );
  const cities = [...new Set(visibleStations.map((item) => item.city ?? 'Другие города'))];
  const mapStations = showLocations
    ? visibleStations.filter(
        (item) => item.isActive !== false && item.latitude != null && item.longitude != null,
      )
    : [];
  const share = currentQuote?.shareMinor ?? null;
  const whole = currentQuote?.wholeCourtMinor ?? null;
  const residency = currentQuote?.residency;
  const residencePrice =
    residency?.status === 'APPLIED'
      ? price(residency.amountMinor)
      : residency?.status === 'NOT_APPLICABLE'
        ? 'Не применяется'
        : 'Нужен расчёт';
  const residenceDetail =
    residency?.status === 'APPLIED'
      ? 'Ваша скидка по условиям ЛК1'
      : residency?.status === 'ACTIVE_UNQUOTED'
        ? 'Резидентство действует, стоимость участия уточняется'
        : residency?.status === 'NOT_APPLICABLE'
          ? 'На выбранное время Резидентство не применяется'
          : 'ЛК1 не подтвердил условия';
  const total = payer === 'self' ? whole : share;
  const canPay = Boolean(payer === 'self' && visibility === 'PRIVATE' && checkoutOffer);
  const selectedDate = selected && DATE_FULL.format(new Date(selected.startsAt));
  const chosenTime = selected && slotTime(selected);
  const quoteError = quote && 'error' in quote ? quote.error : undefined;
  const slotChanged = quoteError === 'GAME_CREATE_SCHEDULE_SLOT_CHANGED';
  const quoteMessage = selected && (
    <>
      {!quote ? (
        <p className="game-schedule-empty" role="status">
          Загружаем цену и условия…
        </p>
      ) : null}
      {quoteError ? (
        <div className="game-schedule-message">
          <p role="alert">
            {slotChanged
              ? 'Этот слот больше недоступен.'
              : quoteError === 'GAME_CREATE_SCHEDULE_RATE_LIMITED'
                ? 'Слишком много запросов цены. Повторите через несколько секунд.'
                : 'Не удалось подтвердить цену ЛК1.'}
          </p>
          <button
            type="button"
            onClick={() => {
              if (slotChanged) {
                resetSlot();
                setRetry((value) => value + 1);
                if (wizard.step === 2) wizard.back();
              } else {
                setQuoteVersion((value) => value + 1);
              }
            }}
          >
            {slotChanged ? 'Обновить расписание' : 'Обновить цену'}
          </button>
        </div>
      ) : null}
      {currentQuote?.wholeCourtMinor === null ? (
        <p className="game-schedule-empty" role="status">
          ЛК1 не вернул цену корта для выбранного времени.
        </p>
      ) : null}
      {quoteExpired ? (
        <div className="game-schedule-message">
          <p role="status">Цена устарела.</p>
          <button type="button" onClick={() => setQuoteVersion((value) => value + 1)}>
            Обновить цену
          </button>
        </div>
      ) : null}
    </>
  );

  return (
    <main className="games-page game-schedule-wizard">
      <header className="game-schedule-header">
        {wizard.step === 0 ? (
          <a className="game-schedule-back" href={gamesHref} aria-label="Назад">
            <img src={backIconUrl} width={32} height={32} alt="" />
          </a>
        ) : (
          <button
            className="game-schedule-back"
            type="button"
            aria-label={wizard.step === 2 ? 'Закрыть' : 'Назад'}
            disabled={checkout?.busy}
            onClick={wizard.back}
          >
            <img src={backIconUrl} width={32} height={32} alt="" />
          </button>
        )}
        <h1 ref={heading} tabIndex={-1}>
          {headerTitle}
        </h1>
      </header>

      {wizard.step === 0 ? (
        <section className="game-schedule-stack" aria-label="Станции">
          <input
            type="search"
            className="game-schedule-input"
            aria-label="Найти станцию"
            placeholder="Найти станцию"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <button
            type="button"
            className="game-schedule-card game-schedule-link game-schedule-station-card"
            aria-expanded={showLocations}
            onClick={() => setShowLocations((value) => !value)}
          >
            <span>
              <strong>Найти на карте</strong>
              <small>Клубы рядом с вами</small>
            </span>
            <img src={stationChevronUrl} width={16} height={28} alt="" />
          </button>
          {showLocations ? (
            <div className="game-schedule-card game-schedule-stack">
              {mapStations.map((item) => (
                <a
                  key={item.id}
                  href={`https://yandex.ru/maps/?ll=${item.longitude}%2C${item.latitude}&z=17`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {item.title}
                </a>
              ))}
              {!mapStations.length ? (
                <p className="game-schedule-empty">Карта станций недоступна.</p>
              ) : null}
            </div>
          ) : null}
          <h2>{query ? 'Результаты поиска' : 'Станции по городам'}</h2>
          {cities.map((city) => (
            <div className="game-schedule-station-list" key={city}>
              <h3>{city}</h3>
              {visibleStations
                .filter((item) => (item.city ?? 'Другие города') === city)
                .map((item) => {
                  const openingSoon = item.isActive === false;
                  const details = openingSoon ? 'Скоро открытие' : stationCourtSummary(item);
                  const detailsId =
                    item.address || details ? `${stationDetailsPrefix}-${item.id}` : undefined;
                  return (
                    <button
                      type="button"
                      key={item.id}
                      className="game-schedule-card game-schedule-link game-schedule-station-card"
                      aria-label={item.title}
                      aria-describedby={detailsId}
                      disabled={openingSoon}
                      onClick={() => chooseStation(item.id)}
                    >
                      <span>
                        <strong>{item.title}</strong>
                        {detailsId ? (
                          <span className="game-schedule-station-details" id={detailsId}>
                            {item.address ? <small>{item.address}</small> : null}
                            {details ? (
                              <small
                                className={openingSoon ? undefined : 'game-schedule-court-count'}
                              >
                                {details}
                              </small>
                            ) : null}
                          </span>
                        ) : null}
                      </span>
                      {!openingSoon ? (
                        <img src={stationChevronUrl} width={16} height={28} alt="" />
                      ) : null}
                    </button>
                  );
                })}
            </div>
          ))}
          {!visibleStations.length ? (
            <p className="game-schedule-empty" role="status">
              Станции не найдены.
            </p>
          ) : null}
        </section>
      ) : null}

      {wizard.step === 1 ? (
        <section className="game-schedule-stack" aria-label="Параметры игры">
          <button
            className="game-schedule-card game-schedule-link"
            type="button"
            onClick={wizard.back}
          >
            <span>
              <strong>{station?.title}</strong>
              {station?.address ? <small>{station.address}</small> : null}
            </span>
            <span aria-hidden="true">›</span>
          </button>
          <h2>Продолжительность</h2>
          <div className="game-schedule-durations" role="group" aria-label="Продолжительность">
            {([60, 90, 120] as const).map((minutes) => (
              <button
                key={minutes}
                type="button"
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
          <h2>Дата и время начала игры</h2>
          <div className="game-schedule-days" role="group" aria-label="Дата игры">
            {days.map((item) => (
              <div key={item.day}>
                <span aria-hidden="true">{item.parts.weekday?.replace('.', '')}</span>
                <button
                  type="button"
                  aria-label={item.label}
                  aria-pressed={day === item.day}
                  onClick={() => {
                    if (day === item.day) return;
                    setDay(item.day);
                    resetSlot();
                  }}
                >
                  <small>{item.parts.month?.replace('.', '').slice(0, 3)}</small>
                  <strong>{item.parts.day}</strong>
                </button>
              </div>
            ))}
          </div>
          {!currentSchedule ? (
            <p className="game-schedule-empty" role="status">
              Загрузка времени…
            </p>
          ) : null}
          {currentSchedule && 'error' in currentSchedule ? (
            <div className="game-schedule-message">
              <p role="alert">
                {currentSchedule.error === 'GAME_CREATE_SCHEDULE_STATION_UNAVAILABLE'
                  ? 'Станция пока не подключена к расписанию ЛК1.'
                  : currentSchedule.error === 'VIVA_REAUTH_REQUIRED'
                    ? 'Для расписания нужен действующий вход через Viva.'
                    : currentSchedule.error === 'GAME_PERMISSION_REQUIRED'
                      ? 'Для просмотра расписания нужен доступ к играм.'
                      : 'Не удалось загрузить расписание.'}
              </p>
              <button type="button" onClick={() => setRetry((value) => value + 1)}>
                Повторить
              </button>
            </div>
          ) : null}
          {currentSchedule && 'value' in currentSchedule && !slots.length ? (
            <p className="game-schedule-empty" role="status">
              Свободных слотов нет. Выберите другую дату или длительность.
            </p>
          ) : null}
          {times.size ? (
            <div className="game-schedule-times" role="group" aria-label="Свободные слоты">
              {[...times.values()].map((item) => (
                <div key={item.startsAt} className="game-schedule-pick">
                  <button
                    type="button"
                    aria-label={slotTime(item)}
                    aria-pressed={preferredStart === item.startsAt}
                    onClick={() => {
                      setPreferredStart(item.startsAt);
                      setSlot(court ? item.id : '');
                    }}
                  >
                    {TIME_LABEL.format(new Date(item.startsAt))}
                  </button>
                  {preferredStart === item.startsAt ? (
                    <button type="button" aria-label="Сбросить выбранное время" onClick={clearTime}>
                      ×
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
          <h2>Корты</h2>
          <div className="game-schedule-courts" role="group" aria-label="Корты">
            {[...courts].map(([id, name]) => (
              <div key={id} className="game-schedule-pick">
                <button type="button" aria-pressed={court === id} onClick={() => chooseCourt(id)}>
                  {name}
                </button>
                {court === id ? (
                  <button type="button" aria-label="Сбросить выбранный корт" onClick={resetSlot}>
                    ×
                  </button>
                ) : null}
              </div>
            ))}
            {!currentSchedule ? (
              <p className="game-schedule-empty" role="status">
                Загрузка кортов…
              </p>
            ) : null}
          </div>
          {selected ? (
            <div className="game-schedule-card game-schedule-payer-card">
              <fieldset className="game-schedule-payers">
                <legend>Кто оплачивает корт?</legend>
                <label className="game-schedule-option">
                  <input
                    type="radio"
                    name="game-schedule-payer"
                    checked={payer === 'split'}
                    onChange={() => choosePayer('split')}
                  />
                  <span className="game-schedule-payer-copy">
                    <strong>Каждый платит за себя</strong>
                    <small>
                      Вы оплачиваете только своё участие. Остальные игроки оплачивают свою часть.
                    </small>
                    <span className="game-schedule-payer-tag">
                      <TrainingPeopleIcon />
                      <span>3 игрока смогут присоединиться</span>
                    </span>
                  </span>
                  <span className="game-schedule-payer-price">
                    <strong>{price(share)}</strong>
                    {residency?.status === 'APPLIED' ? (
                      <small>
                        Резидентство <span>{residencePrice}</span>
                      </small>
                    ) : !quote ? (
                      <small>Проверяем цену и условия…</small>
                    ) : null}
                  </span>
                </label>
                <label className="game-schedule-option">
                  <input
                    type="radio"
                    name="game-schedule-payer"
                    checked={payer === 'self'}
                    onChange={() => choosePayer('self')}
                  />
                  <span className="game-schedule-payer-copy">
                    <strong>Я оплачиваю весь корт</strong>
                    <small>
                      Вы оплачиваете весь корт сами. Доступность игры выбирается на следующем шаге.
                    </small>
                    <span className="game-schedule-payer-tag">
                      <TrainingPeopleIcon />
                      Соберу игроков сам
                    </span>
                  </span>
                  <span className="game-schedule-payer-price">
                    <strong>{price(whole)}</strong>
                  </span>
                </label>
              </fieldset>
            </div>
          ) : null}
          {quoteMessage}
          <button
            className="game-schedule-primary game-schedule-continue"
            aria-label="Продолжить"
            type="button"
            disabled={!selected}
            onClick={() => wizard.advance(2)}
          >
            <strong>Продолжить</strong>
            <span>
              {station && selected
                ? `${station.title} · ${selected.courtName}`
                : 'Выберите станцию и корт'}
            </span>
            <span>{chosenTime ? `${chosenTime} · ${duration} мин` : 'Выберите время начала'}</span>
          </button>
        </section>
      ) : null}

      {wizard.step === 2 && station && selected ? (
        <section className="game-schedule-stack" aria-label="Создание игры">
          <section className="game-schedule-card game-schedule-summary" aria-label="Выбранная игра">
            <div>
              <strong>{station.title}</strong>
              <button type="button" onClick={wizard.back}>
                Изменить
              </button>
            </div>
            <span>
              <EventLocationIcon /> {selected.courtName}
              <span className="game-schedule-summary-dot" aria-hidden="true">
                •
              </span>
              <EventCalendarIcon />
              {selectedDate}
            </span>
            <span>
              <svg viewBox="0 0 20 20" aria-hidden="true">
                <circle cx="10" cy="10" r="6.9" />
                <path d="M10 6.6V10L12.55 11.55" />
              </svg>
              {chosenTime}
              <span className="game-schedule-summary-dot" aria-hidden="true">
                •
              </span>
              <svg viewBox="0 0 20 20" aria-hidden="true">
                <circle cx="10" cy="11" r="5.9" />
                <path d="M10 8.3V11L12.05 12.35M7.1 3.75H12.9M6 5.2L4.9 4.1M14 5.2L15.1 4.1" />
              </svg>
              {duration} мин
            </span>
            <span>
              <svg viewBox="0 0 20 20" aria-hidden="true">
                <circle cx="7.1" cy="7.15" r="2.2" />
                <path d="M3.9 14.6C4.1 12.6 5.43 11.25 7.1 11.25S10.1 12.6 10.3 14.6" />
                <circle cx="13.55" cy="8.05" r="1.8" />
                <path d="M11.55 14.25C11.78 12.82 12.78 11.85 13.97 11.85S16.16 12.82 16.39 14.25" />
              </svg>
              {payer === 'self' ? 'Я оплачиваю весь корт' : 'Каждый платит за себя'}
            </span>
          </section>
          <section className="game-schedule-card game-schedule-stack">
            <div className="game-schedule-section-row">
              <h2>Уровень игроков</h2>
              <small>
                {LEVELS[levels[0]]} - {LEVELS[levels[1]]}
              </small>
            </div>
            <div className="game-schedule-level-panel">
              <div className="game-schedule-levels" role="group" aria-label="Уровень игры">
                {LEVELS.map((level, index) => (
                  <button
                    type="button"
                    key={level}
                    aria-pressed={index >= levels[0] && index <= levels[1]}
                    onClick={() => chooseLevel(index)}
                  >
                    {level}
                  </button>
                ))}
              </div>
            </div>
          </section>
          <section className="game-schedule-card game-schedule-stack">
            <h2>Доступность игры</h2>
            <div className="game-schedule-visibility">
              <label className="game-schedule-option">
                <input
                  type="radio"
                  name="game-schedule-visibility"
                  checked={visibility === 'PUBLIC'}
                  onChange={() => setVisibility('PUBLIC')}
                />
                <span>
                  <strong>Открытая игра</strong>
                  <small>К игре может присоединиться любой игрок подходящего уровня</small>
                </span>
                <em>
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <path
                      d="M8.92 1.75L4.7 8.08H7.4L6.63 14.25L10.96 7.92H8.2L8.92 1.75Z"
                      fill="currentColor"
                    />
                  </svg>
                  Быстрее собрать
                </em>
              </label>
              <label className="game-schedule-option">
                <input
                  type="radio"
                  name="game-schedule-visibility"
                  checked={visibility === 'PRIVATE'}
                  onChange={() => setVisibility('PRIVATE')}
                />
                <span>
                  <strong>Приватная игра</strong>
                  <small>
                    Присоединиться можно по ссылке или в сообществе, где игра опубликована
                  </small>
                </span>
                <em>
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <rect x="4.2" y="7.2" width="7.6" height="5.7" rx="1.7" />
                    <path d="M5.75 7.2V5.95a2.25 2.25 0 0 1 4.5 0V7.2" />
                    <circle cx="8" cy="10" r="0.8" fill="currentColor" />
                  </svg>
                  Для своих
                </em>
              </label>
            </div>
          </section>
          {visibility === 'PUBLIC' ? (
            <section className="game-schedule-card game-schedule-stack">
              <h2>Публикация в сообщества</h2>
              <div className="game-schedule-community">
                <div className="is-selected">
                  <span className="game-schedule-community-check" aria-hidden="true" />
                  <img src={padlHubLogoUrl} alt="" />
                  <strong>Общий список игр</strong>
                </div>
                <div>
                  <span className="game-schedule-community-check" aria-hidden="true" />
                  <span className="game-schedule-community-avatar" aria-hidden="true">
                    {station.title.slice(0, 1).toLocaleUpperCase('ru-RU')}
                  </span>
                  <strong>{station.title}</strong>
                </div>
              </div>
              <small>Автопубликация в сообщества на тестовом стенде отключена.</small>
            </section>
          ) : null}
          <section className="game-schedule-card game-schedule-stack">
            <label className="game-schedule-stack">
              <strong>Название игры для публикации</strong>
              <input
                className="game-schedule-input"
                value={title}
                maxLength={160}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="Например, вечерний матч на счёт"
              />
            </label>
            <label className="game-schedule-stack">
              <strong>Комментарий для участников</strong>
              <textarea
                className="game-schedule-input"
                disabled
                placeholder="Комментарий недоступен в этом сценарии"
              />
            </label>
          </section>
          <section className="game-schedule-card game-schedule-stack game-schedule-payment">
            <h2>Выберите способ записи</h2>
            <div className="game-schedule-option game-schedule-payment-row">
              <span className="game-schedule-radio" aria-hidden="true" />
              <span>
                <strong>{payer === 'self' ? 'Оплата всего корта' : 'Разовое участие'}</strong>
                <small>
                  {payer === 'self' ? 'Полная оплата за 4 игроков' : 'Моя доля 1/4 стоимости'}
                </small>
              </span>
              <strong>{price(total)}</strong>
            </div>
            {payer === 'split' ? (
              <>
                <h3>Записаться с дополнительными опциями</h3>
                <div className="game-schedule-option game-schedule-payment-row">
                  <span className="game-schedule-radio is-empty" aria-hidden="true" />
                  <span>
                    <strong>С Резидентством</strong>
                    <small>{residenceDetail}</small>
                  </span>
                  <strong>{residencePrice}</strong>
                </div>
                <div className="game-schedule-option game-schedule-payment-row">
                  <span className="game-schedule-radio is-empty" aria-hidden="true" />
                  <span>
                    <strong>Запись с подпиской</strong>
                    <small>Условия уточняются в ЛК1</small>
                  </span>
                  <strong>Нужен расчёт</strong>
                </div>
                <details>
                  <summary>Применимость льгот</summary>
                  <p>{residenceDetail}. При оплате всего корта льготы не применяются.</p>
                </details>
              </>
            ) : null}
            {quoteMessage}
            <button
              type="button"
              className="game-schedule-primary"
              disabled={!canPay || checkout?.busy}
              onClick={(event) => {
                if (!checkout || !checkoutOffer || !canPay) return;
                if (Date.parse(checkoutOffer.expiresAt) <= Date.now()) {
                  setExpiredQuoteKey(quoteKey);
                  return;
                }
                checkout.start(event, checkoutOffer.offer, {
                  title: title.trim(),
                  levelRange: { from: LEVELS[levels[0]]!, to: LEVELS[levels[1]]! },
                });
              }}
            >
              {checkout?.busy
                ? 'Открываем оплату…'
                : total === null
                  ? 'Записаться'
                  : `Записаться за ${price(total)}`}
            </button>
            {checkout && !canPay ? (
              <p className="game-schedule-empty" role="status">
                Оплата выбранного слота сейчас недоступна.
              </p>
            ) : null}
            {checkout?.error ? <p role="alert">{checkout.error}</p> : null}
            <details>
              <summary>Условия записи</summary>
              <p>ЛК1 подтверждает цену и доступность при оформлении.</p>
            </details>
          </section>
        </section>
      ) : null}
    </main>
  );
}
