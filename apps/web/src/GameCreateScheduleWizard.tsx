import { useEffect, useId, useRef, useState } from 'react';
import type {
  GameCreateScheduleQuote,
  GameCreateScheduleSlot,
  WholeCourtCheckoutOffer,
} from '@phub/api-sdk';
import { EventCalendarIcon } from './ActivityCardIcons.js';
import backIconUrl from './assets/game-schedule-back.svg';
import stationChevronUrl from './assets/game-schedule-station-chevron.svg';
import padlHubLogoUrl from './assets/padlhub-logo.svg';
import { locationCourtLabel } from './location-court-label.js';
import { PlayerLevelAvatar } from './PlayerLevelAvatar.js';
import type { GameCreateStep } from './use-game-create-wizard.js';
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
const DATE_CHIP = new Intl.DateTimeFormat('ru-RU', {
  timeZone: TIME_ZONE,
  weekday: 'short',
  month: 'short',
  day: '2-digit',
});
const MONTH_LABEL = new Intl.DateTimeFormat('ru-RU', { timeZone: TIME_ZONE, month: 'long' });
const LEVELS = ['D', 'D+', 'C', 'C+', 'B', 'B+', 'A'] as const;
const LEVEL_QUARTERS = ['₁', '₂', '₃', '₄'] as const;
const QUARTERS_PER_LEVEL = LEVEL_QUARTERS.length;
// Revisit some ranges so each tap moves just one edge by one step.
const SINGLE_LEVEL_RANGES = [
  [1, 4],
  [2, 4],
  [3, 4],
  [3, 3],
  [2, 3],
  [2, 2],
  [1, 2],
  [1, 1],
  [1, 2],
  [1, 3],
  [2, 3],
  [2, 4],
  [3, 4],
  [4, 4],
  [3, 4],
  [2, 4],
] as const;
const GAME_FORMATS = [
  { id: 'doubles', label: '2 на 2' },
  { id: 'singles', label: '1 на 1' },
] as const;
type Level = (typeof LEVELS)[number];
type LevelDisplay = { readonly level: Level; readonly step?: number };
type LevelRangeDisplay = readonly [LevelDisplay] | readonly [LevelDisplay, LevelDisplay];
type ScheduleFriend = {
  readonly id: string;
  readonly name: string;
  readonly avatarUrl?: string | null;
};
type QuarterRange = {
  readonly from: number;
  readonly to: number;
  readonly restoreFrom: boolean;
  readonly restoreTo: boolean;
  readonly singleLevelStep: number;
};

function quarterDisplay(quarter: number): LevelDisplay {
  return {
    level: LEVELS[Math.floor(quarter / QUARTERS_PER_LEVEL)]!,
    step: (quarter % QUARTERS_PER_LEVEL) + 1,
  };
}

function quarterRangeDisplay({ from, to }: QuarterRange): LevelRangeDisplay {
  const lower = quarterDisplay(from);
  const upper = quarterDisplay(to);
  if (from === to) return [lower];
  const startsAtFirstStep = lower.step === 1;
  const endsAtLastStep = upper.step === QUARTERS_PER_LEVEL;
  if (lower.level === upper.level) {
    return startsAtFirstStep && endsAtLastStep ? [{ level: lower.level }] : [lower, upper];
  }
  return [
    startsAtFirstStep ? { level: lower.level } : lower,
    endsAtLastStep ? { level: upper.level } : upper,
  ];
}

function levelDisplayText({ level, step }: LevelDisplay) {
  return step === undefined ? level : `${level}${LEVEL_QUARTERS[step - 1]}`;
}

function LevelMark({ level, step }: LevelDisplay) {
  return (
    <span className="game-schedule-level-mark">
      <span>{level[0]}</span>
      {level.endsWith('+') ? <sup>+</sup> : null}
      {step === undefined ? null : <sub>{step}</sub>}
    </span>
  );
}

function LevelRange({ range: [lower, upper] }: { range: LevelRangeDisplay }) {
  return (
    <span className="game-schedule-level-range">
      <LevelMark {...lower} />
      {upper ? (
        <>
          {' … '}
          <LevelMark {...upper} />
        </>
      ) : null}
    </span>
  );
}

function changeQuarterRange(range: QuarterRange, index: number): QuarterRange {
  const first = index * QUARTERS_PER_LEVEL;
  const last = first + QUARTERS_PER_LEVEL - 1;
  if (last < range.from) return { ...range, from: first, restoreFrom: false, singleLevelStep: 0 };
  if (first > range.to) return { ...range, to: last, restoreTo: false, singleLevelStep: 0 };
  if (first <= range.from && last >= range.to) {
    const singleLevelStep = (range.singleLevelStep + 1) % SINGLE_LEVEL_RANGES.length;
    const [from, to] = SINGLE_LEVEL_RANGES[singleLevelStep]!;
    return {
      from: first + from - 1,
      to: first + to - 1,
      restoreFrom: from === QUARTERS_PER_LEVEL,
      restoreTo: to === 1,
      singleLevelStep,
    };
  }
  if (first <= range.from) {
    const from = range.from + (range.restoreFrom ? -1 : 1);
    return {
      ...range,
      from,
      restoreFrom: from === last || (range.restoreFrom && from > first),
    };
  }
  if (last >= range.to) {
    const to = range.to + (range.restoreTo ? 1 : -1);
    return {
      ...range,
      to,
      restoreTo: to === first || (range.restoreTo && to < last),
    };
  }
  return { from: first, to: last, restoreFrom: false, restoreTo: false, singleLevelStep: 0 };
}

export interface GameCreateScheduleDetails {
  readonly title: string;
  readonly levelRange: { readonly from: Level; readonly to: Level };
  readonly inviteeUserIds?: readonly string[];
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

type ScheduleDisplayQuote = GameCreateScheduleQuote & {
  readonly subscriptionMinor?: number;
};

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
  }) => Promise<ScheduleDisplayQuote>;
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

function stationAddressWithoutCity({ address, city }: Station) {
  if (!address || !city) return address;
  const comma = address.indexOf(',');
  if (comma === -1) return address;
  const prefix = address
    .slice(0, comma)
    .trim()
    .replace(/^(?:г\.?\s+|г\.\s*|город\s+)/iu, '');
  return prefix.toLocaleLowerCase('ru-RU') === city.trim().toLocaleLowerCase('ru-RU')
    ? address.slice(comma + 1).trim()
    : address;
}

function stationCourtSummary(station: Station) {
  const { courtCount, panoramicCourtsCount, singleCourtsCount, outdoorCourtsCount } = station;
  const courtTypes = [
    panoramicCourtsCount != null && `панорамик: ${panoramicCourtsCount}`,
    singleCourtsCount != null && `сингл: ${singleCourtsCount}`,
    outdoorCourtsCount != null && `открытые: ${outdoorCourtsCount}`,
  ].filter(Boolean);
  if (courtTypes.length) return courtTypes.join(' · ');
  return courtCount === undefined ? null : `${courtCount} ${locationCourtLabel(courtCount)}`;
}

function slotTime(slot: GameCreateScheduleSlot) {
  return `${TIME_LABEL.format(new Date(slot.startsAt))}–${TIME_LABEL.format(new Date(slot.endsAt))}`;
}

function endsNextDay(slot: GameCreateScheduleSlot) {
  return DAY.format(new Date(slot.startsAt)) !== DAY.format(new Date(slot.endsAt));
}

function courtDisplay(name: string) {
  const number = name.match(/корт\s*№\s*(\d+)/iu)?.[1];
  const type = name.match(/панорамик|сингл|открыт/iu)?.[0].toLocaleLowerCase('ru-RU');
  return {
    title: number ? `Корт №${number}` : name,
    type: type === 'открыт' ? 'Открытый' : type && type[0]!.toUpperCase() + type.slice(1),
  };
}

export function GameCreateScheduleWizard({
  stations,
  source,
  checkout,
  previewLevelQuarters = false,
  previewFriends,
  loadFriends,
  gamesHref = '/games',
  today = DAY.format(new Date()),
}: {
  readonly stations: readonly Station[];
  readonly source: GameCreateScheduleSource;
  readonly checkout?: GameCreateScheduleCheckout;
  readonly previewLevelQuarters?: boolean;
  readonly previewFriends?: readonly ScheduleFriend[];
  readonly loadFriends?: () => Promise<readonly ScheduleFriend[]>;
  readonly gamesHref?: string;
  readonly today?: string;
}) {
  const [step, setStep] = useState<GameCreateStep>(0);
  const stationDetailsPrefix = useId();
  const cityPanelPrefix = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const inviteHeadingId = useId();
  const [stationId, setStation] = useState(stations[0]?.id ?? '');
  const [search, setSearch] = useState('');
  const [collapsedCities, setCollapsedCities] = useState<ReadonlySet<string>>(() => new Set());
  const [showLocations, setShowLocations] = useState(false);
  const [preferredStart, setPreferredStart] = useState('');
  const [payer, setPayer] = useState<'split' | 'self'>('split');
  const [visibility, setVisibility] = useState<'PUBLIC' | 'PRIVATE'>('PUBLIC');
  const [friendSearch, setFriendSearch] = useState('');
  const [selectedFriends, setSelectedFriends] = useState<ReadonlySet<string>>(() => new Set());
  const [friends, setFriends] = useState<readonly ScheduleFriend[] | 'ERROR'>();
  const [friendsRetry, setFriendsRetry] = useState(0);
  const [levels, setLevels] = useState<readonly [number, number]>([0, 2]);
  const [quarterRange, setQuarterRange] = useState<QuarterRange>({
    from: 0,
    to: 3 * QUARTERS_PER_LEVEL - 1,
    restoreFrom: false,
    restoreTo: false,
    singleLevelStep: 0,
  });
  // A checkout can only save the whole-level range supported by the current API.
  const showLevelQuarters = previewLevelQuarters && !checkout;
  const showFriendPicker = loadFriends !== undefined || (previewFriends !== undefined && !checkout);
  const [title, setTitle] = useState('');
  const [day, setDay] = useState(today);
  const [format, setFormat] = useState<(typeof GAME_FORMATS)[number]['id']>('doubles');
  const [duration, setDuration] = useState<60 | 90 | 120>(60);
  const [court, setCourt] = useState('');
  const [slotId, setSlot] = useState('');
  const [retry, setRetry] = useState(0);
  const [quoteVersion, setQuoteVersion] = useState(0);
  const [expiredQuoteKey, setExpiredQuoteKey] = useState<string>();
  const [slotsRead, setSlotsRead] = useState<ReadResult<readonly GameCreateScheduleSlot[]>>();
  const [quoteRead, setQuoteRead] = useState<ReadResult<ScheduleDisplayQuote>>();
  useEffect(() => {
    if (!loadFriends || step !== 2) return;
    let current = true;
    void loadFriends().then(
      (items) => {
        if (!current) return;
        setFriends(items);
        setSelectedFriends(
          (selected) =>
            new Set(items.filter((item) => selected.has(item.id)).map((item) => item.id)),
        );
      },
      () => {
        if (current) setFriends('ERROR');
      },
    );
    return () => {
      current = false;
    };
  }, [loadFriends, step, friendsRetry]);
  const scheduleOpen = step !== 0;
  const station = stations.find((item) => item.id === stationId);
  const scheduleKey = JSON.stringify([stationId, day, duration, retry]);
  const currentSchedule = slotsRead?.key === scheduleKey ? slotsRead : undefined;
  const slots =
    currentSchedule && 'value' in currentSchedule
      ? currentSchedule.value.filter(
          ({ courtName }) =>
            /сингл|single|1\s*на\s*1|1\s*[xх×]\s*1/i.test(courtName) === (format === 'singles'),
        )
      : [];
  const courts = new Map(
    slots
      .filter((slot) => !preferredStart || slot.startsAt === preferredStart)
      .map(({ courtKey, courtName }) => [courtKey, courtName]),
  );
  const chosenSlot = slots.find((slot) => slot.id === slotId && slot.courtKey === court);
  const selected = format === 'doubles' ? chosenSlot : undefined;
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
    return {
      day: DAY.format(date),
      label: DATE_LABEL.format(date),
      month: MONTH_LABEL.format(date),
      parts,
    };
  });
  const months = new Map<string, typeof days>();
  for (const item of days) {
    const monthDays = months.get(item.month);
    if (monthDays) monthDays.push(item);
    else months.set(item.month, [item]);
  }

  useEffect(() => {
    if (!stationId || step === 0 || currentSchedule) return;
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
  }, [source, stationId, day, duration, scheduleKey, currentSchedule, step]);

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
  }, [step]);

  function clearTime() {
    setSlot('');
    setPreferredStart('');
  }

  function resetSlot() {
    setCourt('');
    clearTime();
  }

  function clearCourt() {
    setCourt('');
    setSlot('');
  }

  function toggleCity(city: string) {
    setCollapsedCities((current) => {
      const next = new Set(current);
      if (next.has(city)) next.delete(city);
      else next.add(city);
      return next;
    });
  }

  function goBack() {
    setStep((current) => (current === 2 ? 1 : 0));
  }

  function chooseStation(id: string) {
    if (id !== stationId) {
      setStation(id);
      resetSlot();
    }
    setStep(1);
  }

  function chooseCourt(id: string) {
    if (id === court) return;
    const matching = slots.find((slot) => slot.courtKey === id && slot.startsAt === preferredStart);
    setCourt(id);
    setSlot(matching?.id ?? '');
  }

  function choosePayer(value: 'split' | 'self') {
    setPayer(value);
    setVisibility(value === 'self' ? 'PRIVATE' : 'PUBLIC');
  }

  function chooseLevel(index: number) {
    if (showLevelQuarters) {
      setQuarterRange((range) => changeQuarterRange(range, index));
      return;
    }
    const [from, to] = levels;
    if (index < from) setLevels([index, to]);
    else if (index > to) setLevels([from, index]);
    else if (index === from && from < to) setLevels([from + 1, to]);
    else if (index === to && from < to) setLevels([from, to - 1]);
    else setLevels([from, index]);
  }

  const headerTitle = ['Выберите клуб', 'Дата и время', 'Создание игры'][step];
  const query = search.trim().toLocaleLowerCase('ru-RU');
  const friendQuery = friendSearch.trim().toLocaleLowerCase('ru-RU').replaceAll('ё', 'е');
  const friendList = loadFriends && friends !== 'ERROR' ? friends : previewFriends;
  const visibleFriends = friendList?.filter((friend) =>
    friend.name.toLocaleLowerCase('ru-RU').replaceAll('ё', 'е').includes(friendQuery),
  );
  const visibleStations = stations.filter((item) =>
    [item.title, item.city, item.address].some((value) =>
      value?.toLocaleLowerCase('ru-RU').includes(query),
    ),
  );
  const cities = Array.from(
    new Set(visibleStations.map((item) => item.city ?? 'Другие города')),
    (city, index) => ({ city, panelId: `${cityPanelPrefix}-${index}` }),
  );
  const CityHeading = query ? 'h3' : 'h2';
  const mapStations = showLocations
    ? visibleStations.filter(
        (item) => item.isActive !== false && item.latitude != null && item.longitude != null,
      )
    : [];
  const share = currentQuote?.shareMinor ?? null;
  const whole = currentQuote?.wholeCourtMinor ?? null;
  const subscription = currentQuote?.subscriptionMinor;
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
  const summaryDate = days.find((item) => item.day === day)?.parts;
  const summarySlot = chosenSlot ?? times.get(preferredStart);
  const summaryCourt = courts.get(court);
  const summaryCourtName = summaryCourt ? courtDisplay(summaryCourt).title : undefined;
  const levelRange: LevelRangeDisplay = showLevelQuarters
    ? quarterRangeDisplay(quarterRange)
    : levels[0] === levels[1]
      ? [{ level: LEVELS[levels[0]]! }]
      : [{ level: LEVELS[levels[0]]! }, { level: LEVELS[levels[1]]! }];
  const payerLabel = payer === 'self' ? 'Я оплачиваю весь корт' : 'Каждый за себя';
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
                if (step === 2) setStep(1);
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
    <main
      className={`games-page game-schedule-wizard${step === 1 ? ' game-schedule-wizard--settings' : ''}`}
    >
      <div className="game-schedule-top">
        <header className="game-schedule-header">
          {step === 0 ? (
            <a className="game-schedule-back" href={gamesHref} aria-label="Назад">
              <img src={backIconUrl} width={32} height={32} alt="" />
            </a>
          ) : (
            <button
              className="game-schedule-back"
              type="button"
              aria-label="Назад"
              disabled={checkout?.busy}
              onClick={goBack}
            >
              <img src={backIconUrl} width={32} height={32} alt="" />
            </button>
          )}
          <h1 ref={heading} tabIndex={-1}>
            {headerTitle}
          </h1>
        </header>
        {scheduleOpen && station ? (
          <section className="game-schedule-card game-schedule-summary" aria-label="Выбранная игра">
            <strong title={summaryCourt}>
              {station.title}
              {summaryCourtName ? ` · ${summaryCourtName}` : ''}
            </strong>
            <button
              type="button"
              aria-label={step === 1 ? 'Изменить клуб' : undefined}
              disabled={checkout?.busy}
              onClick={goBack}
            >
              Изменить
            </button>
            <span>
              <EventCalendarIcon />
              <span>
                {summaryDate
                  ? `${Number(summaryDate.day)} ${summaryDate.month?.slice(0, 3)} · `
                  : ''}
                {summarySlot ? slotTime(summarySlot) : `${duration} мин`}
              </span>
            </span>
            <span
              role={selected ? 'group' : undefined}
              aria-label={selected ? 'Уровень игроков' : undefined}
            >
              {selected ? (
                <>
                  <svg
                    className="game-schedule-level-icon"
                    viewBox="0 0 16 12"
                    fill="currentColor"
                    aria-hidden="true"
                  >
                    <rect x="0" y="1.5" width="3.2" height="9" rx="0.65" />
                    <rect x="4.25" y="1.5" width="3.2" height="9" rx="0.65" opacity=".8" />
                    <rect x="8.5" y="1.5" width="3.2" height="9" rx="0.65" opacity=".5" />
                    <rect x="12.75" y="1.5" width="3.2" height="9" rx="0.65" opacity=".35" />
                  </svg>
                  <LevelRange range={levelRange} />
                </>
              ) : null}
            </span>
            <span>
              <TrainingPeopleIcon />
              {selected ? payerLabel : GAME_FORMATS.find((option) => option.id === format)?.label}
            </span>
            <span>
              {selected ? (
                <>
                  <svg
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.2"
                    aria-hidden="true"
                  >
                    <rect x="2.5" y="7" width="11" height="7" rx="1.5" />
                    {visibility === 'PUBLIC' ? (
                      <path d="M5 7V5a3 3 0 0 1 5.5-1.7" />
                    ) : (
                      <path d="M5 7V5a3 3 0 0 1 6 0v2M8 9.5v2" />
                    )}
                  </svg>
                  {visibility === 'PUBLIC' ? 'Открытая' : 'Приватная'}
                </>
              ) : null}
            </span>
          </section>
        ) : null}
      </div>

      {step === 0 ? (
        <section className="game-schedule-stack" aria-label="Клубы">
          <div className="game-schedule-club-tools">
            <input
              type="search"
              className="game-schedule-input"
              aria-label="Найти клуб"
              placeholder="Найти клуб"
              value={search}
              onChange={(event) => {
                const value = event.target.value;
                setSearch(value);
                if (value.trim()) {
                  setCollapsedCities((current) => (current.size ? new Set() : current));
                }
              }}
            />
            <button
              type="button"
              className="game-schedule-map-toggle"
              aria-expanded={showLocations}
              onClick={() => setShowLocations((value) => !value)}
            >
              Карта
            </button>
          </div>
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
                <p className="game-schedule-empty">Карта клубов недоступна.</p>
              ) : null}
            </div>
          ) : null}
          {query ? <h2 className="game-schedule-station-heading">Результаты поиска</h2> : null}
          <div className="game-schedule-station-panel">
            {cities.map(({ city, panelId }) => {
              const cityOpen = !collapsedCities.has(city);
              return (
                <div className="game-schedule-station-list" key={city}>
                  <CityHeading className="game-schedule-city-heading">
                    <button
                      type="button"
                      className="game-schedule-disclosure"
                      aria-controls={panelId}
                      aria-expanded={cityOpen}
                      onClick={() => toggleCity(city)}
                    >
                      <span>{city}</span>
                      <img src={stationChevronUrl} width={16} height={28} alt="" />
                    </button>
                  </CityHeading>
                  <div id={panelId} className="game-schedule-station-panel" hidden={!cityOpen}>
                    {visibleStations
                      .filter((item) => (item.city ?? 'Другие города') === city)
                      .map((item) => {
                        const openingSoon = item.isActive === false;
                        const details = openingSoon ? 'Скоро открытие' : stationCourtSummary(item);
                        const address = stationAddressWithoutCity(item);
                        const detailsId =
                          address || details ? `${stationDetailsPrefix}-${item.id}` : undefined;
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
                                  {address ? (
                                    <small className="game-schedule-station-meta">{address}</small>
                                  ) : null}
                                  {details ? (
                                    <small
                                      className={
                                        openingSoon ? undefined : 'game-schedule-station-meta'
                                      }
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
                </div>
              );
            })}
            {!visibleStations.length ? (
              <p className="game-schedule-empty" role="status">
                Клубы не найдены.
              </p>
            ) : null}
          </div>
        </section>
      ) : null}

      {step === 1 ? (
        <section className="game-schedule-stack game-schedule-settings" aria-label="Параметры игры">
          <div className="game-schedule-settings-section">
            <h2 className="game-schedule-settings-heading">Формат игры</h2>
            <div className="game-schedule-formats" role="group" aria-label="Формат игры">
              {GAME_FORMATS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  aria-pressed={option.id === format}
                  onClick={() => {
                    if (option.id === format) return;
                    setFormat(option.id);
                    resetSlot();
                  }}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
          <div className="game-schedule-settings-section">
            <h2 className="game-schedule-settings-heading">Продолжительность</h2>
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
          </div>
          <div className="game-schedule-settings-section">
            <h2 className="game-schedule-settings-heading">Дата игры</h2>
            <div className="game-schedule-days" role="group" aria-label="Дата игры">
              {[...months].map(([month, monthDays]) => (
                <div
                  key={month}
                  className="game-schedule-month-group"
                  role="group"
                  aria-label={month}
                >
                  <span className="game-schedule-month" aria-hidden="true">
                    {month}
                  </span>
                  <div className="game-schedule-month-dates">
                    {monthDays.map((item) => (
                      <button
                        key={item.day}
                        type="button"
                        aria-label={item.label}
                        aria-pressed={day === item.day}
                        onClick={() => {
                          if (day === item.day) return;
                          setDay(item.day);
                          resetSlot();
                        }}
                      >
                        <small>{item.parts.weekday?.replace('.', '')}</small>
                        <strong>{item.parts.day}</strong>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="game-schedule-settings-section">
            <h2 className="game-schedule-settings-heading">Время начала</h2>
            {!currentSchedule ? (
              <p className="game-schedule-empty" role="status">
                Загрузка времени…
              </p>
            ) : null}
            {currentSchedule && 'error' in currentSchedule ? (
              <div className="game-schedule-message">
                <p role="alert">
                  {currentSchedule.error === 'GAME_CREATE_SCHEDULE_STATION_UNAVAILABLE'
                    ? 'Для этого клуба расписание ЛК1 пока недоступно.'
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
                Для этого формата нет свободных слотов. Выберите другую дату или длительность.
              </p>
            ) : null}
            {times.size ? (
              <div className="game-schedule-times" role="group" aria-label="Свободные слоты">
                {[...times.values()].map((item) => {
                  const nextDay = endsNextDay(item);
                  return (
                    <div key={item.startsAt} className="game-schedule-pick">
                      <button
                        type="button"
                        aria-label={`${slotTime(item)}${nextDay ? ', окончание на следующий день' : ''}`}
                        aria-pressed={preferredStart === item.startsAt}
                        onClick={() => {
                          setPreferredStart(item.startsAt);
                          setSlot(court ? item.id : '');
                        }}
                      >
                        {TIME_LABEL.format(new Date(item.startsAt))}
                      </button>
                      {preferredStart === item.startsAt ? (
                        <button
                          type="button"
                          aria-label="Сбросить выбранное время"
                          onClick={clearTime}
                        >
                          ×
                        </button>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ) : null}
          </div>
          <div className="game-schedule-settings-section">
            <div className="game-schedule-settings-row">
              <h2 className="game-schedule-settings-heading">Корты</h2>
              {courts.size > 0 ? (
                <span>
                  {courts.size} {locationCourtLabel(courts.size)}
                </span>
              ) : null}
            </div>
            <div className="game-schedule-courts" role="group" aria-label="Корты">
              {[...courts].map(([id, name]) => {
                const { title: courtTitle, type } = courtDisplay(name);
                return (
                  <div key={id} className="game-schedule-pick">
                    <button
                      type="button"
                      aria-label={courtTitle}
                      aria-description={type}
                      aria-pressed={court === id}
                      onClick={() => chooseCourt(id)}
                    >
                      <strong>{courtTitle}</strong>
                      {type ? <small>{type}</small> : null}
                    </button>
                    {court === id ? (
                      <button
                        type="button"
                        aria-label="Сбросить выбранный корт"
                        onClick={clearCourt}
                      >
                        ×
                      </button>
                    ) : null}
                  </div>
                );
              })}
              {!currentSchedule ? (
                <p className="game-schedule-empty" role="status">
                  Загрузка кортов…
                </p>
              ) : null}
            </div>
          </div>
          {selected ? (
            <div className="game-schedule-card game-schedule-payer-card">
              <fieldset className="game-schedule-payers">
                <legend className="game-schedule-settings-heading">Кто оплачивает корт?</legend>
                <label className="game-schedule-option">
                  <input
                    type="radio"
                    name="game-schedule-payer"
                    checked={payer === 'split'}
                    onChange={() => choosePayer('split')}
                  />
                  <span className="game-schedule-payer-copy">
                    <span className="game-schedule-payer-line">
                      <strong>Каждый за себя</strong>
                      <strong className="game-schedule-payer-price">{price(share)}</strong>
                    </span>
                    <small>Вы оплачиваете только своё участие</small>
                    {subscription !== undefined || residency?.status === 'APPLIED' ? (
                      <small className="game-schedule-payer-benefits">
                        {subscription !== undefined ? (
                          <span className="game-schedule-payer-line">
                            По подписке <span>{price(subscription)}</span>
                          </span>
                        ) : null}
                        {residency?.status === 'APPLIED' ? (
                          <span className="game-schedule-payer-line">
                            С резидентством <span>{residencePrice}</span>
                          </span>
                        ) : null}
                      </small>
                    ) : !quote ? (
                      <small className="game-schedule-payer-benefits">
                        Проверяем цену и условия…
                      </small>
                    ) : null}
                    <span className="game-schedule-payer-note">
                      <TrainingPeopleIcon />
                      <span>3 игрока смогут присоединиться</span>
                    </span>
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
                    <span className="game-schedule-payer-line">
                      <strong>Весь корт</strong>
                      <strong className="game-schedule-payer-price">{price(whole)}</strong>
                    </span>
                    <small>Остальным игрокам платить не нужно</small>
                    <span className="game-schedule-payer-note">
                      <TrainingPeopleIcon />
                      Соберу игроков сам
                    </span>
                  </span>
                </label>
              </fieldset>
            </div>
          ) : null}
          {quoteMessage}
          {format === 'singles' ? (
            <p className="game-schedule-empty" role="status">
              Запись на игру 1 на 1 пока недоступна.
            </p>
          ) : (
            <button
              className="game-schedule-primary game-schedule-continue"
              aria-label="Продолжить"
              type="button"
              disabled={!selected}
              onClick={() => setStep(2)}
            >
              <strong>Продолжить</strong>
              <span>
                {selected && summaryDate
                  ? `${Number(summaryDate.day)} ${summaryDate.month?.slice(0, 3)} · ${chosenTime}${endsNextDay(selected) ? ' (след. день)' : ''} · ${summaryCourtName}`
                  : 'Выберите корт и время начала'}
              </span>
            </button>
          )}
        </section>
      ) : null}

      {step === 2 && station && selected ? (
        <section className="game-schedule-stack game-schedule-review" aria-label="Создание игры">
          <section className="game-schedule-card game-schedule-stack">
            <div className="game-schedule-settings-row">
              <h2 className="game-schedule-settings-heading">Уровень игроков</h2>
              <span aria-live={showLevelQuarters ? 'polite' : undefined}>
                <LevelRange range={levelRange} />
              </span>
            </div>
            <div
              className={`game-schedule-levels${showLevelQuarters ? ' game-schedule-levels--quarters' : ''}`}
              role="group"
              aria-label="Уровень игры"
            >
              {LEVELS.map((level, index) => {
                const first = index * QUARTERS_PER_LEVEL;
                const last = first + QUARTERS_PER_LEVEL - 1;
                const from = Math.max(quarterRange.from, first);
                const to = Math.min(quarterRange.to, last);
                const selected = showLevelQuarters
                  ? from <= to
                  : index >= levels[0] && index <= levels[1];
                const lower = showLevelQuarters && from === quarterRange.from && selected;
                const upper = showLevelQuarters && to === quarterRange.to && selected;
                const mark: LevelDisplay =
                  lower && (from > first || to < last)
                    ? quarterDisplay(from)
                    : upper && to < last
                      ? quarterDisplay(to)
                      : { level };
                const fillLeft = (from - first) * 25;
                const fillRight = (last - to) * 25;
                return (
                  <button
                    type="button"
                    key={level}
                    aria-label={level}
                    aria-description={
                      lower && upper
                        ? levelRange.map(levelDisplayText).join(' … ')
                        : mark.step !== undefined
                          ? levelDisplayText(mark)
                          : undefined
                    }
                    aria-pressed={selected}
                    onClick={() => chooseLevel(index)}
                  >
                    <LevelMark {...mark} />
                    {showLevelQuarters && selected ? (
                      <span
                        className="game-schedule-level-fill"
                        style={{ clipPath: `inset(0 ${fillRight}% 0 ${fillLeft}%)` }}
                        aria-hidden="true"
                      >
                        <LevelMark {...mark} />
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
            {showLevelQuarters ? (
              <small className="game-schedule-review-note">
                {Math.floor(quarterRange.from / QUARTERS_PER_LEVEL) ===
                Math.floor(quarterRange.to / QUARTERS_PER_LEVEL)
                  ? 'Нажимайте на выбранный уровень, чтобы перебрать диапазоны по ступеням.'
                  : 'Нажимайте на край диапазона, чтобы менять его по ступеням.'}
              </small>
            ) : null}
          </section>
          <section className="game-schedule-card game-schedule-stack">
            <h2 className="game-schedule-settings-heading">Доступность игры</h2>
            <div className="game-schedule-visibility" role="group" aria-label="Доступность игры">
              <label className="game-schedule-option">
                <input
                  type="radio"
                  name="game-schedule-visibility"
                  checked={visibility === 'PUBLIC'}
                  onChange={() => setVisibility('PUBLIC')}
                />
                <span>
                  <strong>Открытая игра</strong>
                  <small>Любой игрок подходящего уровня может присоединиться.</small>
                </span>
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
                  <small>Присоединение к игре по ссылке</small>
                </span>
              </label>
            </div>
          </section>
          {visibility === 'PUBLIC' ? (
            <section className="game-schedule-card game-schedule-stack">
              <h2 className="game-schedule-settings-heading">Публикация в сообщества</h2>
              <div className="game-schedule-community">
                <div className="is-selected">
                  <img src={padlHubLogoUrl} alt="" />
                  <strong>Общий список игр</strong>
                  <span className="game-schedule-community-check" aria-hidden="true" />
                </div>
                <div>
                  <span className="game-schedule-community-avatar" aria-hidden="true">
                    {station.title.slice(0, 1).toLocaleUpperCase('ru-RU')}
                  </span>
                  <strong>{station.title}</strong>
                  <span className="game-schedule-community-check" aria-hidden="true" />
                </div>
              </div>
              <small className="game-schedule-review-note">
                Автопубликация в сообщества на тестовом стенде отключена.
              </small>
            </section>
          ) : null}
          {showFriendPicker ? (
            <section
              className="game-schedule-card game-schedule-stack"
              aria-labelledby={inviteHeadingId}
            >
              <div className="game-schedule-settings-row">
                <h2 className="game-schedule-settings-heading" id={inviteHeadingId}>
                  Пригласить друзей
                </h2>
                <span aria-live="polite">
                  {selectedFriends.size > 0 ? `Выбрано ${selectedFriends.size}` : null}
                </span>
              </div>
              <input
                type="search"
                className="game-schedule-input"
                aria-label="Найти друга"
                placeholder="Найти друга"
                value={friendSearch}
                disabled={friendList === undefined}
                onChange={(event) => setFriendSearch(event.target.value)}
              />
              {loadFriends && friends === 'ERROR' ? (
                <div className="game-schedule-message">
                  <p role="alert">Не удалось загрузить список друзей.</p>
                  <button
                    type="button"
                    onClick={() => {
                      setFriends(undefined);
                      setFriendsRetry((previous) => previous + 1);
                    }}
                  >
                    Повторить загрузку
                  </button>
                </div>
              ) : loadFriends && friends === undefined ? (
                <p className="game-schedule-empty" role="status">
                  Загружаем друзей…
                </p>
              ) : visibleFriends?.length ? (
                <div className="game-schedule-friend-list">
                  {visibleFriends.map((friend) => (
                    <label className="game-schedule-friend" key={friend.id}>
                      <span aria-hidden="true">
                        <PlayerLevelAvatar
                          alt={friend.name}
                          src={friend.avatarUrl ?? null}
                          fallbackSeed={friend.id}
                          showLevelRing={false}
                          size={32}
                        />
                      </span>
                      <strong>{friend.name}</strong>
                      <input
                        type="checkbox"
                        checked={selectedFriends.has(friend.id)}
                        onChange={(event) => {
                          const checked = event.target.checked;
                          setSelectedFriends((current) => {
                            const next = new Set(current);
                            if (checked) next.add(friend.id);
                            else next.delete(friend.id);
                            return next;
                          });
                        }}
                      />
                    </label>
                  ))}
                </div>
              ) : (
                <p className="game-schedule-empty" role="status">
                  {friendQuery ? 'Никого не нашли' : 'Список друзей пуст'}
                </p>
              )}
            </section>
          ) : null}
          <section className="game-schedule-card game-schedule-stack">
            <label className="game-schedule-review-field">
              <strong>Название игры для публикации</strong>
              <input
                className="game-schedule-input"
                value={title}
                maxLength={160}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="Например, вечерний матч на счёт"
              />
            </label>
            <label className="game-schedule-review-field">
              <strong>Комментарий для участников</strong>
              <textarea
                className="game-schedule-input"
                disabled
                placeholder="Комментарий недоступен в этом сценарии"
              />
            </label>
          </section>
          <section className="game-schedule-card game-schedule-stack game-schedule-payment">
            <h2 className="game-schedule-settings-heading">Стоимость участия</h2>
            <div className="game-schedule-option game-schedule-payment-row game-schedule-payment-row--primary">
              <span>
                <strong>{payer === 'self' ? 'Оплата всего корта' : 'Разовое участие'}</strong>
                <small>
                  {payer === 'self' ? 'Полная оплата за 4 игроков' : 'Моя доля 1/4 стоимости'}
                </small>
              </span>
              <strong className="game-schedule-payer-price">{price(total)}</strong>
            </div>
            {payer === 'split' ? (
              <>
                <h3>Дополнительные способы записи</h3>
                <div className="game-schedule-option game-schedule-payment-row">
                  <span>
                    <strong>С Резидентством</strong>
                    <small>{residenceDetail}</small>
                  </span>
                  <strong>{residencePrice}</strong>
                </div>
                <div className="game-schedule-option game-schedule-payment-row">
                  <span>
                    <strong>Запись с подпиской</strong>
                    {subscription === undefined ? <small>Условия уточняются в ЛК1</small> : null}
                  </span>
                  <strong>
                    {subscription === undefined ? 'Нужен расчёт' : price(subscription)}
                  </strong>
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
              className="game-schedule-primary game-schedule-review-action"
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
                  ...(loadFriends && selectedFriends.size
                    ? { inviteeUserIds: [...selectedFriends] }
                    : {}),
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
