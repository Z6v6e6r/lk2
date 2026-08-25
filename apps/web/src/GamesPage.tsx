import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';

import { BookingActivityCard } from './BookingRecommendations.js';
import { GameCard, type GameCardAction, type GameCardModel } from './GameCard.js';
import { GameDetailView, type GameDetailTab } from './GameDetailView.js';
import {
  MainBottomNavigation,
  UpcomingBookingCard,
  type HomeUpcomingItem,
} from './HomeDashboardPage.js';
import { TournamentSummaryCard } from './TournamentSummaryCard.js';
import { profileUserIdForParticipant } from './game-participant-profile.js';
import type {
  AuthGateway,
  EventCatalogItem,
  EventCatalogPage,
  EventCatalogQuery,
  GameCard as ViewerGameCard,
  GameCommandResult,
  LevelAssessmentDefinition,
  PlayerLevelState,
  PublicGameCard,
} from './auth-gateway.js';
import { usePaginatedEventSearch } from './usePaginatedEventSearch.js';

type GamesTab = 'DISCOVER' | 'UPCOMING';

type GameKindFilter = 'GAME' | 'COACH_GAME' | 'TOURNAMENT';
type GameLevelRangeFilter = 'ALL' | 'D_C_PLUS' | 'C_C_PLUS' | 'C_B_PLUS' | 'B_A';
type GameStartAfterFilter = 'ALL' | '18:00';
type CatalogLevel = NonNullable<EventCatalogQuery['levelFrom']>;

const catalogLevels: readonly CatalogLevel[] = ['D', 'D+', 'C', 'C+', 'B', 'B+', 'A'];

const gameKindOptions: readonly {
  readonly value: GameKindFilter;
  readonly label: string;
}[] = [
  { value: 'GAME', label: 'Игра' },
  { value: 'COACH_GAME', label: 'Игра + Тренер' },
  { value: 'TOURNAMENT', label: 'Турнир' },
];

const levelRangeFilters = {
  ALL: null,
  D_C_PLUS: { from: 'D', to: 'C+' },
  C_C_PLUS: { from: 'C', to: 'C+' },
  C_B_PLUS: { from: 'C', to: 'B+' },
  B_A: { from: 'B', to: 'A' },
} as const;

const levelRangeLabels: Readonly<Record<GameLevelRangeFilter, string>> = {
  ALL: 'Любой уровень',
  D_C_PLUS: 'D–C+',
  C_C_PLUS: 'C–C+',
  C_B_PLUS: 'C–B+',
  B_A: 'B–A',
};

const weekdayFormatter = new Intl.DateTimeFormat('ru-RU', { weekday: 'short' });
const dayFormatter = new Intl.DateTimeFormat('ru-RU', { day: '2-digit' });
const LEVEL_RECOVERY_STORAGE_KEY = 'phub.pending-level-recovery.v1';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isCatalogLevel(value: string): value is CatalogLevel {
  return catalogLevels.some((level) => level === value);
}

function clearPendingLevelRecovery(): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(LEVEL_RECOVERY_STORAGE_KEY);
  } catch {
    // The authoritative command result does not depend on browser storage cleanup.
  }
}

function dateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

type GamesCatalogQuery = Omit<EventCatalogQuery, 'surface' | 'kinds'> & {
  readonly surface: 'GAMES';
  readonly kinds: GameKindFilter[];
};

type GamesCatalogMetadata = Pick<
  EventCatalogPage,
  'state' | 'totalMatched' | 'facets' | 'sourceStatus'
>;

function mergeStations(
  current: readonly { readonly id: string; readonly name: string }[],
  incoming: readonly { readonly id: string; readonly name: string }[],
): readonly { readonly id: string; readonly name: string }[] {
  const merged = new Map(current.map((station) => [station.id, station.name]));
  incoming.forEach((station) => merged.set(station.id, station.name));
  return [...merged]
    .map(([id, name]) => ({ id, name }))
    .sort((left, right) => left.name.localeCompare(right.name, 'ru-RU'));
}

function FilterTypeIcon(): React.JSX.Element {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20">
      <rect x="2.5" y="2.5" width="5.5" height="5.5" rx="1.2" />
      <rect x="12" y="2.5" width="5.5" height="5.5" rx="1.2" />
      <rect x="2.5" y="12" width="5.5" height="5.5" rx="1.2" />
      <rect x="12" y="12" width="5.5" height="5.5" rx="1.2" />
    </svg>
  );
}

function FilterStationIcon(): React.JSX.Element {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20">
      <path d="M16.5 8.3c0 4.5-6.5 9.2-6.5 9.2S3.5 12.8 3.5 8.3a6.5 6.5 0 1 1 13 0Z" />
      <circle cx="10" cy="8" r="2.2" />
    </svg>
  );
}

function MultiSelectFilter({
  ariaLabel,
  icon,
  options,
  selectedValues,
  summary,
  wide = false,
  onToggle,
}: {
  readonly ariaLabel: string;
  readonly icon: React.JSX.Element;
  readonly options: readonly { readonly value: string; readonly label: string }[];
  readonly selectedValues: readonly string[];
  readonly summary: string;
  readonly wide?: boolean;
  readonly onToggle: (value: string) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const handleDocumentClick = (event: MouseEvent): void => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('click', handleDocumentClick);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('click', handleDocumentClick);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  return (
    <div className={`games-multiselect${wide ? ' games-multiselect--wide' : ''}`} ref={rootRef}>
      <button
        className="games-multiselect__trigger"
        type="button"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((current) => !current)}
      >
        {icon}
        <span>{summary}</span>
        <span className="games-filter-chevron" aria-hidden="true">
          ⌄
        </span>
      </button>
      {open ? (
        <div className="games-multiselect__menu" id={menuId} role="group" aria-label={ariaLabel}>
          {options.map((option) => (
            <label key={option.value}>
              <input
                type="checkbox"
                checked={selectedValues.includes(option.value)}
                onChange={() => onToggle(option.value)}
              />
              <span>{option.label}</span>
            </label>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function FilterSlidersIcon(): React.JSX.Element {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20">
      <path d="M2.5 5h6M12.5 5h5M2.5 15h4M10.5 15h7M2.5 10h10M16.5 10h1" />
      <circle cx="10.5" cy="5" r="2" />
      <circle cx="8.5" cy="15" r="2" />
      <circle cx="14.5" cy="10" r="2" />
    </svg>
  );
}

function errorMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    switch ((error as { readonly code?: unknown }).code) {
      case 'GAME_FULL':
        return 'Свободное место уже заняли. Обновили состав игры.';
      case 'GAME_ALREADY_JOINED':
        return 'Вы уже участвуете в этой игре.';
      case 'GAME_JOIN_CUTOFF_PASSED':
        return 'Запись уже закрыта.';
      case 'GAME_REVISION_CONFLICT':
        return 'Состав изменился. Проверьте актуальные места и повторите.';
      case 'GAME_NOT_FOUND':
        return 'Игра больше недоступна.';
      case 'LEVEL_NOT_ALLOWED':
        return 'Эта игра рассчитана на другой уровень.';
      case 'PLAYER_LEVEL_UNKNOWN':
      case 'LEVEL_SCALE_VERSION_MISMATCH':
        return 'Не удалось подтвердить актуальный уровень. Обновите профиль и повторите.';
      case 'GAME_RESULT_INVALID_ROSTER':
        return 'Состав результата не совпадает с участниками игры.';
      case 'GAME_RESULT_REVIEW_FORBIDDEN':
        return 'Автор результата не может подтвердить его сам.';
      case 'GAME_RESULT_STATE_CONFLICT':
        return 'Результат уже изменился. Обновили карточку игры.';
      default:
        break;
    }
  }
  return 'Не удалось выполнить действие. Проверьте связь и повторите.';
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function initialDetailTab(game: ViewerGameCard): GameDetailTab {
  return Date.parse(game.endsAt) <= Date.now() ? 'RESULT' : 'GAME';
}

export interface GamesPageProps {
  readonly gateway: AuthGateway;
  readonly gameId?: string;
  readonly eventId?: string;
}

export function GamesPage({ gateway, gameId, eventId }: GamesPageProps): React.JSX.Element {
  const [tab, setTab] = useState<GamesTab>('DISCOVER');
  const [selectedKinds, setSelectedKinds] = useState<readonly GameKindFilter[]>([]);
  const [selectedStationIds, setSelectedStationIds] = useState<readonly string[]>([]);
  const [stations, setStations] = useState<
    readonly { readonly id: string; readonly name: string }[]
  >([]);
  const [levelRange, setLevelRange] = useState<GameLevelRangeFilter>('ALL');
  const [ownLevelFilter, setOwnLevelFilter] = useState<CatalogLevel | null>(null);
  const [ownLevelFilterLoading, setOwnLevelFilterLoading] = useState(false);
  const [startsAfter, setStartsAfter] = useState<GameStartAfterFilter>('ALL');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [selectedDate, setSelectedDate] = useState<string | null>(() => dateKey(new Date()));
  const [includeFull, setIncludeFull] = useState(false);
  const [games, setGames] = useState<readonly GameCardModel[]>([]);
  const [detail, setDetail] = useState<ViewerGameCard | null>(null);
  const [eventBooking, setEventBooking] = useState<HomeUpcomingItem | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [busyGameId, setBusyGameId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<GameDetailTab>('GAME');
  const [reloadToken, setReloadToken] = useState(0);
  const [levelRecovery, setLevelRecovery] = useState<{
    readonly action: 'JOIN' | 'JOIN_WAITLIST';
    readonly game: GameCardModel;
  } | null>(null);
  const [levelState, setLevelState] = useState<PlayerLevelState | null>(null);
  const [selectedLevelId, setSelectedLevelId] = useState('');
  const [levelRecoveryMode, setLevelRecoveryMode] = useState<'choice' | 'manual' | 'assessment'>(
    'choice',
  );
  const [levelRecoveryBusy, setLevelRecoveryBusy] = useState<'loading' | 'saving' | null>(null);
  const [levelRecoveryError, setLevelRecoveryError] = useState<string | null>(null);
  const [assessmentDefinition, setAssessmentDefinition] =
    useState<LevelAssessmentDefinition | null>(null);
  const [assessmentAnswers, setAssessmentAnswers] = useState<
    Readonly<Record<string, readonly string[]>>
  >({});
  const [assessmentIndex, setAssessmentIndex] = useState(0);
  const pendingViewerGame = useRef<ViewerGameCard | null>(null);
  const invitationId = useMemo(() => {
    if (typeof window === 'undefined' || !gameId) return undefined;
    const candidate = new URLSearchParams(window.location.search).get('invitationId')?.trim();
    return candidate && UUID_PATTERN.test(candidate) ? candidate : undefined;
  }, [gameId]);
  const assessmentQuestions = useMemo(() => {
    if (!assessmentDefinition) return [];
    const base = assessmentDefinition.questions.find(
      (question) => question.id === assessmentDefinition.baseQuestionId,
    );
    if (!base) return [];
    const baseOption = assessmentAnswers[assessmentDefinition.baseQuestionId]?.[0];
    const branchIds = baseOption ? (assessmentDefinition.branches[baseOption] ?? []) : [];
    return [
      base,
      ...branchIds.flatMap((questionId) => {
        const question = assessmentDefinition.questions.find((item) => item.id === questionId);
        return question ? [question] : [];
      }),
    ];
  }, [assessmentAnswers, assessmentDefinition]);
  const currentAssessmentQuestion = assessmentQuestions[assessmentIndex];

  const days = useMemo(
    () =>
      Array.from({ length: 15 }, (_, index) => {
        const date = new Date();
        date.setHours(0, 0, 0, 0);
        date.setDate(date.getDate() + index);
        return {
          key: dateKey(date),
          day: dayFormatter.format(date),
          weekday: weekdayFormatter.format(date).replace('.', ''),
        };
      }),
    [],
  );

  const catalogEnabled = !gameId && !eventId && tab === 'DISCOVER';
  const catalogQuery = useMemo<GamesCatalogQuery>(() => {
    const selectedRange = ownLevelFilter
      ? { from: ownLevelFilter, to: ownLevelFilter }
      : levelRangeFilters[levelRange];
    return {
      surface: 'GAMES',
      localDates: selectedDate ? [selectedDate] : days.map((day) => day.key),
      kinds: selectedKinds.length > 0 ? [...selectedKinds] : ['GAME', 'COACH_GAME', 'TOURNAMENT'],
      ...(selectedStationIds.length > 0 ? { stationIds: [...selectedStationIds].sort() } : {}),
      availability: includeFull ? 'INCLUDE_FULL' : 'EXCLUDE_FULL',
      ...(selectedRange ? { levelFrom: selectedRange.from, levelTo: selectedRange.to } : {}),
      ...(startsAfter === 'ALL' ? {} : { startsAfterLocal: startsAfter }),
      limit: 20,
    };
  }, [
    days,
    includeFull,
    levelRange,
    ownLevelFilter,
    selectedDate,
    selectedKinds,
    selectedStationIds,
    startsAfter,
  ]);
  const catalogQueryKey = useMemo(
    () =>
      `${catalogEnabled ? 'active' : 'inactive'}:${reloadToken}:${JSON.stringify(catalogQuery)}`,
    [catalogEnabled, catalogQuery, reloadToken],
  );
  const loadCatalogPage = useCallback(
    async (query: GamesCatalogQuery, request: { readonly cursor?: string }) => {
      if (!catalogEnabled) return { items: [] as readonly EventCatalogItem[], nextCursor: null };
      const page = request.cursor
        ? await gateway.continueEventCatalog(request.cursor, query.limit)
        : await gateway.listEventCatalog(query);
      return {
        items: page.items,
        nextCursor: page.nextCursor,
        metadata: {
          state: page.state,
          totalMatched: page.totalMatched,
          facets: page.facets,
          sourceStatus: page.sourceStatus,
        } satisfies GamesCatalogMetadata,
      };
    },
    [catalogEnabled, gateway],
  );
  const {
    items: catalogItems,
    nextCursor: catalogNextCursor,
    metadata: catalogMetadata,
    loading: catalogLoading,
    loadingMore: catalogLoadingMore,
    error: catalogError,
    errorPhase: catalogErrorPhase,
    loadMore: loadMoreCatalog,
    retry: retryCatalog,
  } = usePaginatedEventSearch<GamesCatalogQuery, EventCatalogItem, GamesCatalogMetadata>({
    queryKey: catalogQueryKey,
    query: catalogQuery,
    loadPage: loadCatalogPage,
    itemKey: (item) =>
      item.kind === 'GAME'
        ? `GAME:${item.game.id}`
        : item.kind === 'TOURNAMENT'
          ? `TOURNAMENT:${item.tournament.id}`
          : `COACH_GAME:${item.activity.id}`,
  });

  useEffect(() => {
    if (gameId || eventId) return;
    let active = true;
    void gateway.listLocations().then(
      (result) => {
        if (!active) return;
        setStations((current) =>
          mergeStations(
            current,
            result.items.map((location) => ({ id: location.id, name: location.title })),
          ),
        );
      },
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [eventId, gameId, gateway]);

  useEffect(() => {
    let active = true;

    if (gameId) {
      void gateway.getGame(gameId).then(
        (game) => {
          if (!active) return;
          setDetail(game);
          setDetailTab(initialDetailTab(game));
          setLoading(false);
        },
        (cause: unknown) => {
          if (!active) return;
          setDetail(null);
          setError(errorMessage(cause));
          setLoading(false);
        },
      );
      return () => {
        active = false;
      };
    }

    if (eventId) {
      void gateway.getUpcomingBookings().then(
        (bookings) => {
          if (!active) return;
          const selected = bookings.items.find((item) => {
            if (item.kind !== 'game') return false;
            const query = item.route.split('?')[1];
            return query ? new URLSearchParams(query).get('event') === eventId : false;
          });
          setEventBooking(selected ?? null);
          setError(selected ? null : 'Карточка этой игры пока недоступна.');
          setLoading(false);
        },
        (cause: unknown) => {
          if (!active) return;
          setEventBooking(null);
          setError(errorMessage(cause));
          setLoading(false);
        },
      );
      return () => {
        active = false;
      };
    }

    if (tab === 'DISCOVER') {
      return () => {
        active = false;
      };
    }

    void gateway.listMyGames({ scope: tab, limit: 20 }).then(
      (page) => {
        if (!active) return;
        const pending = tab === 'UPCOMING' ? pendingViewerGame.current : null;
        const hasPending = pending ? page.items.some((item) => item.id === pending.id) : false;
        setGames(pending && !hasPending ? [pending, ...page.items] : page.items);
        setStations((current) =>
          mergeStations(
            current,
            page.items.map((item) => ({ id: item.station.id, name: item.station.name })),
          ),
        );
        if (hasPending) pendingViewerGame.current = null;
        setNextCursor(page.nextCursor ?? null);
        setLoading(false);
      },
      (cause: unknown) => {
        if (!active) return;
        setGames([]);
        setNextCursor(null);
        setError(errorMessage(cause));
        setLoading(false);
      },
    );
    return () => {
      active = false;
    };
  }, [eventId, gameId, gateway, reloadToken, tab]);

  async function loadMore(): Promise<void> {
    if (tab === 'DISCOVER') return loadMoreCatalog();
    if (!nextCursor || loadingMore || gameId) return;
    setLoadingMore(true);
    setError(null);
    try {
      const page = await gateway.listMyGames({ scope: tab, limit: 20, cursor: nextCursor });
      const pageItems = page.items;
      setGames((current) => [...current, ...pageItems]);
      setStations((current) =>
        mergeStations(
          current,
          pageItems.map((item) => ({ id: item.station.id, name: item.station.name })),
        ),
      );
      setNextCursor(page.nextCursor ?? null);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoadingMore(false);
    }
  }

  const selectedStations = useMemo(
    () => stations.filter((station) => selectedStationIds.includes(station.id)),
    [selectedStationIds, stations],
  );
  const visibleEvents = useMemo(
    () =>
      tab === 'DISCOVER'
        ? catalogItems.map((item) =>
            item.kind === 'GAME'
              ? { type: 'GAME' as const, game: item.game }
              : item.kind === 'TOURNAMENT'
                ? { type: 'TOURNAMENT' as const, tournament: item.tournament }
                : { type: 'TRAINING' as const, activity: item.activity },
          )
        : games.map((game) => ({ type: 'GAME' as const, game })),
    [catalogItems, games, tab],
  );
  const activeFilterCount =
    Number(selectedKinds.length > 0) +
    Number(selectedStationIds.length > 0) +
    Number(includeFull) +
    Number(levelRange !== 'ALL') +
    Number(ownLevelFilter !== null) +
    Number(startsAfter !== 'ALL');
  const kindSummary =
    selectedKinds.length === 0
      ? 'Все типы'
      : selectedKinds.length === 1
        ? (gameKindOptions.find((option) => option.value === selectedKinds[0])?.label ??
          'Тип события')
        : `Типы: ${selectedKinds.length}`;
  const stationSummary =
    selectedStations.length === 0
      ? 'Все станции'
      : selectedStations.length === 1
        ? (selectedStations[0]?.name ?? 'Станция')
        : `Станции: ${selectedStations.length}`;

  function beginFilterChange(): void {
    setError(null);
  }

  function toggleKind(value: GameKindFilter): void {
    beginFilterChange();
    setSelectedKinds((current) => {
      return current.includes(value)
        ? current.filter((item) => item !== value)
        : [...current, value];
    });
  }

  function toggleStation(stationId: string): void {
    beginFilterChange();
    setSelectedStationIds((current) => {
      return current.includes(stationId)
        ? current.filter((item) => item !== stationId)
        : [...current, stationId];
    });
  }

  async function toggleOwnLevelFilter(): Promise<void> {
    beginFilterChange();
    if (ownLevelFilter) {
      setOwnLevelFilter(null);
      return;
    }
    if (!gateway.getOwnPlayerLevel || ownLevelFilterLoading) return;

    setOwnLevelFilterLoading(true);
    try {
      const state = await gateway.getOwnPlayerLevel('PADEL');
      const code = state.currentLevel?.code;
      if (!code || !isCatalogLevel(code)) {
        setError('Сначала укажите уровень в профиле, чтобы найти подходящие события.');
        return;
      }
      setLevelRange('ALL');
      setOwnLevelFilter(code);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setOwnLevelFilterLoading(false);
    }
  }

  function resetFilters(): void {
    if (activeFilterCount === 0) return;
    beginFilterChange();
    setSelectedKinds([]);
    setSelectedStationIds([]);
    setIncludeFull(false);
    setLevelRange('ALL');
    setOwnLevelFilter(null);
    setStartsAfter('ALL');
  }

  async function handleParticipantProfileRequest(
    game: GameCardModel,
    participant: GameCardModel['participants'][number],
    participantIndex: number,
  ): Promise<void> {
    if ('userId' in participant && typeof participant.userId === 'string') {
      window.location.assign(`/profile/${encodeURIComponent(participant.userId)}`);
      return;
    }
    setError(null);
    try {
      const viewerGame = await gateway.getGame(game.id);
      const userId = profileUserIdForParticipant(
        game as PublicGameCard,
        participant,
        participantIndex,
        viewerGame,
      );
      if (!userId) {
        setError('Профиль этого участника пока недоступен.');
        return;
      }
      window.location.assign(`/profile/${encodeURIComponent(userId)}`);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  async function openLevelRecovery(
    action: 'JOIN' | 'JOIN_WAITLIST',
    game: GameCardModel,
  ): Promise<void> {
    if (!gateway.getOwnPlayerLevel || !gateway.setOwnPlayerLevel) {
      setError('Укажите уровень в профиле и повторите запись.');
      return;
    }
    const pending = {
      action,
      gameId: game.id,
      returnPath:
        typeof window === 'undefined'
          ? `/games/${encodeURIComponent(game.id)}`
          : `${window.location.pathname}${window.location.search}${window.location.hash}`,
      ...(invitationId ? { invitationId } : {}),
    };
    if (typeof window !== 'undefined') {
      try {
        window.sessionStorage.setItem(LEVEL_RECOVERY_STORAGE_KEY, JSON.stringify(pending));
      } catch {
        // In-memory recovery remains available when browser storage is unavailable.
      }
    }
    setLevelRecovery({ action, game });
    setLevelRecoveryMode('choice');
    setLevelState(null);
    setSelectedLevelId('');
    setAssessmentDefinition(null);
    setAssessmentAnswers({});
    setAssessmentIndex(0);
    setLevelRecoveryError(null);
    setLevelRecoveryBusy('loading');
    try {
      const state = await gateway.getOwnPlayerLevel('PADEL');
      setLevelState(state);
      setSelectedLevelId(state.currentLevel?.levelId ?? state.levels[0]?.id ?? '');
    } catch {
      setLevelRecoveryError('Не удалось загрузить шкалу уровней. Повторите позже.');
    } finally {
      setLevelRecoveryBusy(null);
    }
  }

  async function handleAction(action: GameCardAction, game: GameCardModel): Promise<void> {
    if (
      ['SUBMIT_RESULT', 'CONFIRM_RESULT', 'DISPUTE_RESULT', 'VIEW_RESULT', 'OPEN_DISPUTE'].includes(
        action,
      )
    ) {
      if (!gameId) {
        window.location.assign(`/games/${encodeURIComponent(game.id)}`);
        return;
      }
      if (['SUBMIT_RESULT', 'VIEW_RESULT', 'OPEN_DISPUTE'].includes(action)) {
        setDetailTab('RESULT');
        return;
      }
      if (busyGameId || !('resultSummary' in game)) return;
      const submissionId = game.resultSummary?.submissionId;
      if (!submissionId) {
        setError('Не удалось определить предложение результата. Обновите карточку.');
        return;
      }
      if (action === 'DISPUTE_RESULT' && !window.confirm('Оспорить этот результат?')) return;
      setBusyGameId(game.id);
      setError(null);
      setNotice(null);
      try {
        const result =
          action === 'CONFIRM_RESULT'
            ? await gateway.confirmGameResult(game.id, submissionId)
            : await gateway.disputeGameResult(game.id, submissionId, { reasonCode: 'OTHER' });
        for (let attempt = 0; attempt < 8; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          const refreshed = await gateway.getGame(game.id);
          setDetail(refreshed);
          if (refreshed.revision >= (result.operation.aggregateRevision ?? 0)) break;
        }
        setNotice(
          action === 'CONFIRM_RESULT'
            ? 'Результат согласован и сохранён в истории игроков.'
            : 'Результат оспорен. Теперь можно отправить исправленный вариант.',
        );
      } catch (cause) {
        setError(errorMessage(cause));
      } finally {
        setBusyGameId(null);
      }
      return;
    }
    if (!['JOIN', 'JOIN_WAITLIST', 'LEAVE_WAITLIST', 'LEAVE'].includes(action) || busyGameId)
      return;
    setBusyGameId(game.id);
    setError(null);
    setNotice(null);
    try {
      const submitted =
        action === 'JOIN'
          ? await gateway.joinGame(
              game.id,
              game.revision,
              game.id === gameId ? invitationId : undefined,
            )
          : action === 'JOIN_WAITLIST'
            ? await gateway.joinGameWaitlist(game.id, game.id === gameId ? invitationId : undefined)
            : action === 'LEAVE_WAITLIST'
              ? await gateway.leaveGameWaitlist(game.id)
              : await gateway.leaveGame(game.id);
      let result = submitted;
      for (
        let attempt = 0;
        attempt < 8 && ['ACCEPTED', 'PROCESSING'].includes(result.operation.status);
        attempt += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        result = await gateway.getGameOperation(result.operation.id);
      }
      if (result.operation.status === 'FAILED') {
        throw Object.assign(new Error(result.operation.error?.message ?? 'Game command failed'), {
          code: result.operation.error?.code,
        });
      }
      if (['ACCEPTED', 'PROCESSING'].includes(result.operation.status)) {
        setNotice('Действие принято. Состав обновится после обработки.');
        setReloadToken((current) => current + 1);
        return;
      }
      if (!result.game && result.operation.gameId) {
        result = {
          ...result,
          game: await gateway.getGame(result.operation.gameId),
        } satisfies GameCommandResult;
      }
      if (result.game) {
        const updatedGame = result.game;
        setDetail((current) => (current?.id === updatedGame.id ? updatedGame : current));
        setGames((current) =>
          current.map((item) => (item.id === updatedGame.id ? updatedGame : item)),
        );
      }
      if (result.operation.nextAction.type === 'OPEN_PAYMENT') {
        clearPendingLevelRecovery();
        pendingViewerGame.current = result.game;
        window.location.assign(result.operation.nextAction.url);
        return;
      }
      setNotice(
        action === 'JOIN'
          ? 'Вы в игре. Состав и доступные действия обновлены.'
          : action === 'JOIN_WAITLIST'
            ? 'Вы добавлены в лист ожидания.'
            : 'Участие обновлено.',
      );
      if (!gameId && (action === 'JOIN' || action === 'JOIN_WAITLIST')) {
        pendingViewerGame.current = result.game;
        setLoading(true);
        setTab('UPCOMING');
      } else {
        setReloadToken((current) => current + 1);
      }
      clearPendingLevelRecovery();
    } catch (cause) {
      if (
        errorCode(cause) === 'PLAYER_LEVEL_REQUIRED' &&
        (action === 'JOIN' || action === 'JOIN_WAITLIST')
      ) {
        await openLevelRecovery(action, game);
        return;
      }
      setError(errorMessage(cause));
      setReloadToken((current) => current + 1);
    } finally {
      setBusyGameId(null);
    }
  }

  async function saveLevelAndContinue(): Promise<void> {
    if (!levelRecovery || !selectedLevelId || !gateway.setOwnPlayerLevel || levelRecoveryBusy)
      return;
    setLevelRecoveryBusy('saving');
    setLevelRecoveryError(null);
    try {
      await gateway.setOwnPlayerLevel(selectedLevelId, 'PADEL');
      const pending = levelRecovery;
      setLevelRecovery(null);
      setLevelState(null);
      setSelectedLevelId('');
      await handleAction(pending.action, pending.game);
    } catch (cause) {
      setLevelRecoveryError(errorMessage(cause));
    } finally {
      setLevelRecoveryBusy(null);
    }
  }

  async function startLevelAssessment(): Promise<void> {
    if (!gateway.getOwnLevelAssessment || !gateway.completeOwnLevelAssessment) {
      setLevelRecoveryError('Определение уровня временно недоступно.');
      return;
    }
    setLevelRecoveryBusy('loading');
    setLevelRecoveryError(null);
    try {
      const definition = await gateway.getOwnLevelAssessment();
      setAssessmentDefinition(definition);
      setAssessmentAnswers({});
      setAssessmentIndex(0);
      setLevelRecoveryMode('assessment');
    } catch {
      setLevelRecoveryError('Не удалось загрузить определение уровня. Повторите позже.');
    } finally {
      setLevelRecoveryBusy(null);
    }
  }

  function selectAssessmentOption(optionId: string): void {
    if (!assessmentDefinition || !currentAssessmentQuestion) return;
    const current = assessmentAnswers[currentAssessmentQuestion.id] ?? [];
    const selected =
      currentAssessmentQuestion.type === 'multi'
        ? current.includes(optionId)
          ? current.filter((id) => id !== optionId)
          : [...current, optionId]
        : [optionId];
    setAssessmentAnswers((answers) =>
      currentAssessmentQuestion.id === assessmentDefinition.baseQuestionId
        ? { [currentAssessmentQuestion.id]: selected }
        : { ...answers, [currentAssessmentQuestion.id]: selected },
    );
    if (currentAssessmentQuestion.id === assessmentDefinition.baseQuestionId) {
      setAssessmentIndex(0);
    }
  }

  async function completeLevelAssessmentAndContinue(): Promise<void> {
    if (
      !levelRecovery ||
      !assessmentDefinition ||
      !gateway.completeOwnLevelAssessment ||
      levelRecoveryBusy
    ) {
      return;
    }
    setLevelRecoveryBusy('saving');
    setLevelRecoveryError(null);
    try {
      await gateway.completeOwnLevelAssessment(assessmentDefinition.version, assessmentAnswers);
      const pending = levelRecovery;
      setLevelRecovery(null);
      setAssessmentDefinition(null);
      setAssessmentAnswers({});
      setAssessmentIndex(0);
      await handleAction(pending.action, pending.game);
    } catch (cause) {
      setLevelRecoveryError(errorMessage(cause));
    } finally {
      setLevelRecoveryBusy(null);
    }
  }

  function closeLevelRecovery(): void {
    clearPendingLevelRecovery();
    setLevelRecovery(null);
    setLevelState(null);
    setSelectedLevelId('');
    setLevelRecoveryError(null);
    setLevelRecoveryBusy(null);
    setAssessmentDefinition(null);
    setAssessmentAnswers({});
    setAssessmentIndex(0);
  }

  function renderLevelRecoveryDialog(): React.JSX.Element | null {
    if (!levelRecovery) return null;
    return (
      <div className="games-level-recovery-backdrop">
        <section
          className="games-level-recovery"
          role="dialog"
          aria-modal="true"
          aria-labelledby="games-level-recovery-title"
        >
          <button
            className="games-level-recovery__close"
            type="button"
            aria-label="Закрыть выбор уровня"
            onClick={closeLevelRecovery}
          >
            ×
          </button>
          <span className="games-level-recovery__eyebrow">Уровень игрока</span>
          <h2 id="games-level-recovery-title">Укажите уровень, чтобы присоединиться</h2>
          <p>Мы сохраним исходную игру и продолжим запись после подтверждения уровня.</p>
          {levelRecoveryMode === 'choice' ? (
            <div className="games-level-recovery__actions">
              <button
                className="games-level-recovery__primary"
                type="button"
                onClick={() => setLevelRecoveryMode('manual')}
              >
                Знаю свой уровень
              </button>
              <button
                className="games-level-recovery__secondary"
                type="button"
                disabled={levelRecoveryBusy !== null}
                onClick={() => void startLevelAssessment()}
              >
                {levelRecoveryBusy === 'loading'
                  ? 'Загружаем определение…'
                  : 'Пройти определение уровня'}
              </button>
            </div>
          ) : levelRecoveryMode === 'manual' ? (
            <div className="games-level-recovery__manual">
              <label>
                Ваш уровень
                <select
                  value={selectedLevelId}
                  disabled={levelRecoveryBusy !== null}
                  onChange={(event) => setSelectedLevelId(event.target.value)}
                >
                  {levelState?.levels.map((level) => (
                    <option value={level.id} key={level.id}>
                      {level.title}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="games-level-recovery__primary"
                type="button"
                disabled={!selectedLevelId || levelRecoveryBusy !== null}
                onClick={() => void saveLevelAndContinue()}
              >
                {levelRecoveryBusy === 'saving' ? 'Сохраняем…' : 'Сохранить и продолжить запись'}
              </button>
              <button
                className="games-level-recovery__back"
                type="button"
                disabled={levelRecoveryBusy !== null}
                onClick={() => setLevelRecoveryMode('choice')}
              >
                Назад
              </button>
            </div>
          ) : currentAssessmentQuestion ? (
            <div className="games-level-assessment">
              <p className="games-level-assessment__progress">
                Вопрос {assessmentIndex + 1} из {assessmentQuestions.length}
              </p>
              <h3>{currentAssessmentQuestion.text}</h3>
              <div className="games-level-assessment__options">
                {currentAssessmentQuestion.options.map((option) => {
                  const selected = (assessmentAnswers[currentAssessmentQuestion.id] ?? []).includes(
                    option.id,
                  );
                  return (
                    <button
                      key={option.id}
                      type="button"
                      className={selected ? 'is-selected' : undefined}
                      aria-pressed={selected}
                      disabled={levelRecoveryBusy !== null}
                      onClick={() => selectAssessmentOption(option.id)}
                    >
                      {option.label}
                    </button>
                  );
                })}
              </div>
              <div className="games-level-assessment__navigation">
                <button
                  className="games-level-recovery__back"
                  type="button"
                  disabled={levelRecoveryBusy !== null}
                  onClick={() => {
                    if (assessmentIndex === 0) setLevelRecoveryMode('choice');
                    else setAssessmentIndex((index) => Math.max(0, index - 1));
                  }}
                >
                  Назад
                </button>
                <button
                  className="games-level-recovery__primary"
                  type="button"
                  disabled={
                    (assessmentAnswers[currentAssessmentQuestion.id]?.length ?? 0) === 0 ||
                    levelRecoveryBusy !== null ||
                    assessmentQuestions.length === 1
                  }
                  onClick={() => {
                    if (assessmentIndex === assessmentQuestions.length - 1) {
                      void completeLevelAssessmentAndContinue();
                    } else {
                      setAssessmentIndex((index) => index + 1);
                    }
                  }}
                >
                  {assessmentIndex === assessmentQuestions.length - 1
                    ? levelRecoveryBusy === 'saving'
                      ? 'Сохраняем…'
                      : 'Завершить и продолжить'
                    : 'Далее'}
                </button>
              </div>
            </div>
          ) : (
            <p role="alert">Анкета недоступна. Вернитесь назад и повторите.</p>
          )}
          {levelRecoveryBusy === 'loading' ? <p role="status">Загружаем шкалу уровней…</p> : null}
          {levelRecoveryError ? (
            <p className="games-level-recovery__error" role="alert">
              {levelRecoveryError}
            </p>
          ) : null}
        </section>
      </div>
    );
  }

  async function submitResult(
    input: Parameters<AuthGateway['submitGameResult']>[1],
  ): Promise<void> {
    if (!detail || busyGameId) return;
    setBusyGameId(detail.id);
    setError(null);
    setNotice(null);
    try {
      const result = await gateway.submitGameResult(detail.id, input);
      for (let attempt = 0; attempt < 8; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        const refreshed = await gateway.getGame(detail.id);
        setDetail(refreshed);
        if (refreshed.revision >= (result.operation.aggregateRevision ?? 0)) break;
      }
      setNotice('Результат отправлен другим участникам на согласование.');
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusyGameId(null);
    }
  }

  async function openGameChat(game: ViewerGameCard): Promise<void> {
    if (busyGameId) return;
    setBusyGameId(game.id);
    setError(null);
    setNotice(null);
    try {
      const result = await gateway.getOrCreateGameConversation(game.id);
      window.location.assign(`/chats/${encodeURIComponent(result.conversation.id)}`);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusyGameId(null);
    }
  }

  if (gameId) {
    return (
      <main className="games-page games-page--detail">
        <header className="games-header">
          <a className="games-back" href="/games" aria-label="Назад к играм">
            <span aria-hidden="true">←</span>
            Назад
          </a>
          <div>
            <h1>Детали матча</h1>
          </div>
        </header>
        {loading ? (
          <div className="games-loading" role="status">
            Загружаем актуальный состав…
          </div>
        ) : null}
        {error ? (
          <p className="games-message is-error" role="alert">
            {error}
          </p>
        ) : null}
        {notice ? (
          <p className="games-message" role="status">
            {notice}
          </p>
        ) : null}
        {detail ? (
          <GameDetailView
            activeTab={detailTab}
            busy={busyGameId === detail.id}
            game={detail}
            onAction={(action) => void handleAction(action, detail)}
            onChatOpen={() => void openGameChat(detail)}
            onSubmit={submitResult}
            onTabChange={setDetailTab}
          />
        ) : null}
        <MainBottomNavigation active="games" gamesDestination="games" />
        {renderLevelRecoveryDialog()}
      </main>
    );
  }

  if (eventId) {
    return (
      <main className="games-page games-page--detail games-page--booking-detail">
        <header className="games-header">
          <a className="games-back" href="/" aria-label="Назад к моим записям">
            <span aria-hidden="true">←</span>
            Назад
          </a>
          <div>
            <h1>Карточка игры</h1>
          </div>
        </header>
        {loading ? (
          <div className="games-loading" role="status">
            Загружаем карточку игры…
          </div>
        ) : null}
        {error ? (
          <p className="games-message is-error" role="alert">
            {error}
          </p>
        ) : null}
        {eventBooking ? (
          <section className="game-booking-detail" aria-label="Выбранная игра">
            <UpcomingBookingCard item={eventBooking} showAction={false} />
          </section>
        ) : null}
        <MainBottomNavigation active="games" gamesDestination="games" />
        {renderLevelRecoveryDialog()}
      </main>
    );
  }

  return (
    <main className="games-page">
      <header className="games-header">
        <a className="games-back" href="/" aria-label="На Главную">
          ←
        </a>
        <div>
          <span>Найти партнёров и корт</span>
        </div>
        <span className="games-header__spacer" aria-hidden="true" />
      </header>

      <nav className="games-tabs" aria-label="Разделы игр">
        {(
          [
            ['DISCOVER', 'Найти игру'],
            ['UPCOMING', 'Для меня'],
          ] as const
        ).map(([value, label]) => (
          <button
            className={tab === value ? 'is-active' : undefined}
            type="button"
            key={value}
            aria-pressed={tab === value}
            onClick={() => {
              if (tab === value) return;
              setLoading(true);
              setError(null);
              setTab(value);
            }}
          >
            {label}
          </button>
        ))}
      </nav>

      {tab === 'DISCOVER' ? (
        <>
          <a className="games-create-hero" href="/games/new" aria-label="Создать игру">
            <strong>Создать игру</strong>
            <span>Выберите станцию, время и собери свою игру</span>
          </a>
          <section className="games-filters" aria-label="Фильтры поиска игр">
            <div className="games-date-rail" aria-label="Выбор даты">
              <button
                className={selectedDate === null ? 'is-active' : undefined}
                type="button"
                aria-pressed={selectedDate === null}
                onClick={() => {
                  if (selectedDate === null) return;
                  beginFilterChange();
                  setSelectedDate(null);
                  setStartsAfter('ALL');
                }}
              >
                <strong>Все</strong>
                <span>даты</span>
              </button>
              {days.map((day) => (
                <button
                  className={selectedDate === day.key ? 'is-active' : undefined}
                  type="button"
                  key={day.key}
                  aria-pressed={selectedDate === day.key}
                  onClick={() => {
                    if (selectedDate === day.key) return;
                    beginFilterChange();
                    setSelectedDate(day.key);
                  }}
                >
                  <strong>{day.day}</strong>
                  <span>{day.weekday}</span>
                </button>
              ))}
            </div>
            <div className="games-filter-panel">
              <div className="games-filter-primary">
                <MultiSelectFilter
                  ariaLabel="Тип события"
                  icon={<FilterTypeIcon />}
                  options={gameKindOptions}
                  selectedValues={selectedKinds}
                  summary={kindSummary}
                  onToggle={(value) => toggleKind(value as GameKindFilter)}
                />
                <MultiSelectFilter
                  ariaLabel="Станции"
                  icon={<FilterStationIcon />}
                  options={stations.map((station) => ({
                    value: station.id,
                    label: station.name,
                  }))}
                  selectedValues={selectedStationIds}
                  summary={stationSummary}
                  onToggle={toggleStation}
                />
                <label className="games-filter-availability">
                  <input
                    type="checkbox"
                    checked={!includeFull}
                    onChange={(event) => {
                      beginFilterChange();
                      setIncludeFull(!event.target.checked);
                    }}
                  />
                  <span>Не показывать набранные</span>
                </label>
              </div>

              <div className="games-filter-actions">
                {gateway.getOwnPlayerLevel ? (
                  <button
                    className="games-filter-more"
                    type="button"
                    aria-pressed={ownLevelFilter !== null}
                    disabled={ownLevelFilterLoading}
                    onClick={() => void toggleOwnLevelFilter()}
                  >
                    {ownLevelFilterLoading
                      ? 'Определяем уровень…'
                      : ownLevelFilter
                        ? `Мой уровень · ${ownLevelFilter}`
                        : 'Под мой уровень'}
                  </button>
                ) : null}
                <button
                  className="games-filter-more"
                  type="button"
                  aria-expanded={filtersOpen}
                  aria-controls="games-advanced-filters"
                  onClick={() => setFiltersOpen((current) => !current)}
                >
                  <FilterSlidersIcon />
                  Все фильтры · {activeFilterCount}
                </button>
                <button
                  className="games-filter-reset"
                  type="button"
                  disabled={activeFilterCount === 0}
                  onClick={resetFilters}
                >
                  Сбросить всё
                </button>
              </div>

              {filtersOpen ? (
                <div className="games-filter-advanced" id="games-advanced-filters">
                  <label className="games-filter-field">
                    <span className="games-filter-label">Время начала</span>
                    <span className="games-filter-select">
                      <select
                        aria-label="Время начала"
                        value={startsAfter}
                        disabled={selectedDate === null}
                        onChange={(event) => {
                          beginFilterChange();
                          setStartsAfter(event.target.value as GameStartAfterFilter);
                        }}
                      >
                        <option value="ALL">Любое время</option>
                        <option value="18:00">После 18:00</option>
                      </select>
                      <span className="games-filter-chevron" aria-hidden="true">
                        ⌄
                      </span>
                    </span>
                  </label>
                  <label className="games-filter-field">
                    <span className="games-filter-label">Уровень игроков</span>
                    <span className="games-filter-select">
                      <select
                        aria-label="Уровень игроков"
                        value={levelRange}
                        disabled={ownLevelFilter !== null}
                        onChange={(event) => {
                          beginFilterChange();
                          setLevelRange(event.target.value as GameLevelRangeFilter);
                        }}
                      >
                        {(Object.keys(levelRangeLabels) as GameLevelRangeFilter[]).map((value) => (
                          <option value={value} key={value}>
                            {levelRangeLabels[value]}
                          </option>
                        ))}
                      </select>
                      <span className="games-filter-chevron" aria-hidden="true">
                        ⌄
                      </span>
                    </span>
                  </label>
                </div>
              ) : null}

              {activeFilterCount > 0 ? (
                <div className="games-filter-chips" aria-label="Выбранные фильтры">
                  {selectedKinds.map((selectedKind) => {
                    const label =
                      gameKindOptions.find((option) => option.value === selectedKind)?.label ??
                      'Тип события';
                    return (
                      <button
                        type="button"
                        aria-label={`Убрать фильтр ${label}`}
                        key={selectedKind}
                        onClick={() => {
                          beginFilterChange();
                          setSelectedKinds((current) =>
                            current.filter((item) => item !== selectedKind),
                          );
                        }}
                      >
                        {label} <span>×</span>
                      </button>
                    );
                  })}
                  {selectedStations.map((station) => (
                    <button
                      type="button"
                      aria-label={`Убрать фильтр ${station.name}`}
                      key={station.id}
                      onClick={() => {
                        beginFilterChange();
                        setSelectedStationIds((current) =>
                          current.filter((item) => item !== station.id),
                        );
                      }}
                    >
                      {station.name} <span>×</span>
                    </button>
                  ))}
                  {includeFull ? (
                    <button
                      type="button"
                      aria-label="Убрать фильтр Показываются набранные"
                      onClick={() => {
                        beginFilterChange();
                        setIncludeFull(false);
                      }}
                    >
                      Набранные <span>×</span>
                    </button>
                  ) : null}
                  {startsAfter !== 'ALL' ? (
                    <button
                      type="button"
                      aria-label="Убрать фильтр После 18:00"
                      onClick={() => {
                        beginFilterChange();
                        setStartsAfter('ALL');
                      }}
                    >
                      После 18:00 <span>×</span>
                    </button>
                  ) : null}
                  {ownLevelFilter ? (
                    <button
                      type="button"
                      aria-label={`Убрать фильтр Мой уровень ${ownLevelFilter}`}
                      onClick={() => {
                        beginFilterChange();
                        setOwnLevelFilter(null);
                      }}
                    >
                      Мой уровень {ownLevelFilter} <span>×</span>
                    </button>
                  ) : levelRange !== 'ALL' ? (
                    <button
                      type="button"
                      aria-label={`Убрать фильтр Уровень ${levelRangeLabels[levelRange]}`}
                      onClick={() => {
                        beginFilterChange();
                        setLevelRange('ALL');
                      }}
                    >
                      Уровень {levelRangeLabels[levelRange]} <span>×</span>
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          </section>
        </>
      ) : null}

      {error ? (
        <p className="games-message is-error" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="games-message" role="status">
          {notice}
        </p>
      ) : null}
      {tab === 'DISCOVER' && catalogError ? (
        <p className="games-message is-error" role="alert">
          События временно недоступны.{' '}
          <button type="button" onClick={() => void retryCatalog()}>
            Повторить
          </button>
        </p>
      ) : null}
      {tab === 'DISCOVER' && catalogMetadata?.state === 'PARTIAL' ? (
        <p className="games-message is-error" role="status">
          Показаны не все события: часть источников временно недоступна.
        </p>
      ) : null}

      <section
        className="games-list"
        aria-live="polite"
        aria-busy={tab === 'DISCOVER' ? catalogLoading : loading}
      >
        {(tab === 'DISCOVER' ? catalogLoading : loading) ? (
          <div className="games-loading" role="status">
            Ищем подходящие игры…
          </div>
        ) : null}
        {!(tab === 'DISCOVER' ? catalogLoading : loading) &&
        !(tab === 'DISCOVER' && catalogError) &&
        visibleEvents.length === 0 ? (
          <div className="games-empty">
            <span aria-hidden="true">◌</span>
            <h2>{tab === 'DISCOVER' ? 'Подходящих событий пока нет' : 'Здесь пока пусто'}</h2>
            <p>
              {tab === 'DISCOVER'
                ? 'Смените дату, тип события, уровень или покажите события без свободных мест.'
                : 'После записи игра появится в этом разделе.'}
            </p>
          </div>
        ) : null}
        {visibleEvents.map((event) =>
          event.type === 'GAME' ? (
            <GameCard
              game={event.game}
              busy={busyGameId === event.game.id}
              key={`game-${event.game.id}`}
              onAction={(action, selectedGame) => void handleAction(action, selectedGame)}
              onParticipantProfileRequest={(selectedGame, participant, participantIndex) =>
                void handleParticipantProfileRequest(selectedGame, participant, participantIndex)
              }
            />
          ) : event.type === 'TRAINING' ? (
            <BookingActivityCard activity={event.activity} key={`training-${event.activity.id}`} />
          ) : (
            <TournamentSummaryCard
              tournament={event.tournament}
              key={`tournament-${event.tournament.id}`}
            />
          ),
        )}
        {(tab === 'DISCOVER' ? catalogNextCursor : nextCursor) ? (
          <button
            className="games-load-more"
            type="button"
            disabled={tab === 'DISCOVER' ? catalogLoadingMore : loadingMore}
            onClick={() => void loadMore()}
          >
            {tab === 'DISCOVER' && catalogErrorPhase === 'more'
              ? 'Повторить загрузку'
              : (tab === 'DISCOVER' ? catalogLoadingMore : loadingMore)
                ? 'Загружаем…'
                : 'Показать ещё'}
          </button>
        ) : null}
      </section>
      <MainBottomNavigation active="games" gamesDestination="games" />
      {renderLevelRecoveryDialog()}
    </main>
  );
}
