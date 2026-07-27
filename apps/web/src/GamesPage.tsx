import { useEffect, useId, useMemo, useRef, useState } from 'react';

import { GameCard, type GameCardAction, type GameCardModel } from './GameCard.js';
import { CoachGameSummaryCard } from './CoachGameSummaryCard.js';
import { GameDetailView, type GameDetailTab } from './GameDetailView.js';
import { MainBottomNavigation } from './HomeDashboardPage.js';
import { TournamentSummaryCard } from './TournamentSummaryCard.js';
import { profileUserIdForParticipant } from './game-participant-profile.js';
import type {
  AuthGateway,
  GameCard as ViewerGameCard,
  GameCommandResult,
  PublicGameCard,
  PublicGameFilters,
  PublicCoachGameSummary,
  PublicTournamentSummary,
} from './auth-gateway.js';

type GamesTab = 'DISCOVER' | 'UPCOMING';

type GameKindFilter = 'GAME' | 'COACH_GAME' | 'TOURNAMENT';
type GameLevelRangeFilter = 'ALL' | 'D_C_PLUS' | 'C_C_PLUS' | 'C_B_PLUS' | 'B_A';
type GameStartAfterFilter = 'ALL' | '18:00';

const gameKindOptions: readonly {
  readonly value: GameKindFilter;
  readonly label: string;
}[] = [
  { value: 'GAME', label: 'Игра' },
  { value: 'COACH_GAME', label: 'Игра + Тренер' },
  { value: 'TOURNAMENT', label: 'Турнир' },
];

function filterIncludesKind(
  selectedKinds: readonly GameKindFilter[],
  kind: GameKindFilter,
): boolean {
  return selectedKinds.length === 0 || selectedKinds.includes(kind);
}

function gameMatchesKind(
  game: Pick<GameCardModel, 'kind'>,
  selectedKinds: readonly GameKindFilter[],
): boolean {
  return filterIncludesKind(selectedKinds, game.kind === 'COACH_GAME' ? 'COACH_GAME' : 'GAME');
}

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

function dateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function dateRange(
  key: string,
  startsAfter: GameStartAfterFilter,
): { readonly startsFrom: string; readonly startsTo: string } {
  const from = new Date(`${key}T${startsAfter === '18:00' ? '18:00:00' : '00:00:00'}`);
  const to = new Date(from);
  if (startsAfter === '18:00') {
    to.setHours(24, 0, 0, 0);
  } else {
    to.setDate(to.getDate() + 1);
  }
  return { startsFrom: from.toISOString(), startsTo: to.toISOString() };
}

function tournamentDateRange(selectedDate: string | null): {
  readonly dateFrom: string;
  readonly dateTo: string;
} {
  const from = selectedDate ? new Date(`${selectedDate}T00:00:00`) : new Date();
  from.setHours(0, 0, 0, 0);
  const to = new Date(from);
  to.setDate(to.getDate() + (selectedDate ? 1 : 15));
  return { dateFrom: dateKey(from), dateTo: dateKey(to) };
}

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

function initialDetailTab(game: ViewerGameCard): GameDetailTab {
  return Date.parse(game.endsAt) <= Date.now() ? 'RESULT' : 'GAME';
}

export interface GamesPageProps {
  readonly gateway: AuthGateway;
  readonly gameId?: string;
}

export function GamesPage({ gateway, gameId }: GamesPageProps): React.JSX.Element {
  const [tab, setTab] = useState<GamesTab>('DISCOVER');
  const [selectedKinds, setSelectedKinds] = useState<readonly GameKindFilter[]>([]);
  const [selectedStationIds, setSelectedStationIds] = useState<readonly string[]>([]);
  const [stations, setStations] = useState<
    readonly { readonly id: string; readonly name: string }[]
  >([]);
  const [levelRange, setLevelRange] = useState<GameLevelRangeFilter>('ALL');
  const [startsAfter, setStartsAfter] = useState<GameStartAfterFilter>('ALL');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [selectedDate, setSelectedDate] = useState<string | null>(() => dateKey(new Date()));
  const [includeFull, setIncludeFull] = useState(true);
  const [games, setGames] = useState<readonly GameCardModel[]>([]);
  const [coachGames, setCoachGames] = useState<readonly PublicCoachGameSummary[]>([]);
  const [tournaments, setTournaments] = useState<readonly PublicTournamentSummary[]>([]);
  const [detail, setDetail] = useState<ViewerGameCard | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [busyGameId, setBusyGameId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<GameDetailTab>('GAME');
  const [reloadToken, setReloadToken] = useState(0);
  const pendingViewerGame = useRef<ViewerGameCard | null>(null);

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

  useEffect(() => {
    if (gameId) return;
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
  }, [gameId, gateway]);

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

    const selectedLevelRange = levelRangeFilters[levelRange];
    const includesRegularGames = filterIncludesKind(selectedKinds, 'GAME');
    const includesCoachGames = filterIncludesKind(selectedKinds, 'COACH_GAME');
    const includesTournaments = filterIncludesKind(selectedKinds, 'TOURNAMENT');
    const filters: PublicGameFilters = {
      availability: includeFull ? 'INCLUDE_FULL' : 'JOINABLE',
      limit: 20,
      ...(!includesRegularGames && includesCoachGames ? { kind: 'COACH_GAME' as const } : {}),
      ...(selectedLevelRange
        ? { levelFrom: selectedLevelRange.from, levelTo: selectedLevelRange.to }
        : {}),
      ...(selectedDate ? dateRange(selectedDate, startsAfter) : {}),
    };
    if (tab === 'DISCOVER') {
      const loadGames =
        !includesRegularGames && !includesCoachGames
          ? Promise.resolve({ items: [], nextCursor: null })
          : selectedStationIds.length <= 1
            ? gateway.listPublicGames({
                ...filters,
                ...(selectedStationIds[0] ? { stationId: selectedStationIds[0] } : {}),
              })
            : Promise.all(
                selectedStationIds.map((stationId) =>
                  gateway.listPublicGames({ ...filters, stationId }),
                ),
              ).then((pages) => ({
                items: [
                  ...new Map(
                    pages.flatMap((page) => page.items).map((item) => [item.id, item] as const),
                  ).values(),
                ],
                nextCursor: null,
              }));
      const loadTournaments =
        !gateway.listPublicTournamentSummaries ||
        !includesTournaments ||
        levelRange !== 'ALL' ||
        startsAfter !== 'ALL'
          ? Promise.resolve({ items: [] })
          : gateway.listPublicTournamentSummaries({
              ...tournamentDateRange(selectedDate),
              availability: includeFull ? 'INCLUDE_FULL' : 'JOINABLE',
              limit: 50,
            });
      const loadCoachGames =
        !gateway.listPublicCoachGameSummaries ||
        !includesCoachGames ||
        levelRange !== 'ALL' ||
        startsAfter !== 'ALL'
          ? Promise.resolve({ items: [] })
          : gateway.listPublicCoachGameSummaries({
              ...tournamentDateRange(selectedDate),
              availability: includeFull ? 'INCLUDE_FULL' : 'JOINABLE',
              limit: 50,
            });
      void Promise.allSettled([loadGames, loadTournaments, loadCoachGames]).then(
        ([gamesResult, tournamentsResult, coachGamesResult]) => {
          if (!active) return;
          if (gamesResult.status === 'rejected') {
            setGames([]);
            setCoachGames(
              coachGamesResult.status === 'fulfilled' ? coachGamesResult.value.items : [],
            );
            setTournaments(
              tournamentsResult.status === 'fulfilled' ? tournamentsResult.value.items : [],
            );
            setNextCursor(null);
            setError(errorMessage(gamesResult.reason));
            setLoading(false);
            return;
          }
          const page = gamesResult.value;
          const pageItems = page.items.filter((item) => gameMatchesKind(item, selectedKinds));
          setGames(pageItems);
          setCoachGames(
            coachGamesResult.status === 'fulfilled' ? coachGamesResult.value.items : [],
          );
          setTournaments(
            tournamentsResult.status === 'fulfilled' ? tournamentsResult.value.items : [],
          );
          setStations((current) =>
            mergeStations(
              current,
              pageItems.map((item) => ({ id: item.station.id, name: item.station.name })),
            ),
          );
          setNextCursor(page.nextCursor ?? null);
          setLoading(false);
        },
      );
      return () => {
        active = false;
      };
    }

    void gateway.listMyGames({ scope: tab, limit: 20 }).then(
      (page) => {
        if (!active) return;
        setTournaments([]);
        setCoachGames([]);
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
        setTournaments([]);
        setCoachGames([]);
        setNextCursor(null);
        setError(errorMessage(cause));
        setLoading(false);
      },
    );
    return () => {
      active = false;
    };
  }, [
    gameId,
    gateway,
    includeFull,
    levelRange,
    reloadToken,
    selectedDate,
    selectedKinds,
    selectedStationIds,
    startsAfter,
    tab,
  ]);

  async function loadMore(): Promise<void> {
    if (!nextCursor || loadingMore || gameId) return;
    setLoadingMore(true);
    setError(null);
    try {
      const includesRegularGames = filterIncludesKind(selectedKinds, 'GAME');
      const includesCoachGames = filterIncludesKind(selectedKinds, 'COACH_GAME');
      const page =
        tab === 'DISCOVER'
          ? !includesRegularGames && !includesCoachGames
            ? { items: [], nextCursor: null }
            : await gateway.listPublicGames({
                availability: includeFull ? 'INCLUDE_FULL' : 'JOINABLE',
                limit: 20,
                cursor: nextCursor,
                ...(!includesRegularGames && includesCoachGames
                  ? { kind: 'COACH_GAME' as const }
                  : {}),
                ...(selectedStationIds[0] ? { stationId: selectedStationIds[0] } : {}),
                ...(levelRangeFilters[levelRange]
                  ? {
                      levelFrom: levelRangeFilters[levelRange].from,
                      levelTo: levelRangeFilters[levelRange].to,
                    }
                  : {}),
                ...(selectedDate ? dateRange(selectedDate, startsAfter) : {}),
              })
          : await gateway.listMyGames({ scope: tab, limit: 20, cursor: nextCursor });
      const pageItems =
        tab === 'DISCOVER'
          ? page.items.filter((item) => gameMatchesKind(item, selectedKinds))
          : page.items;
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
  const selectedStationNames = useMemo(
    () => new Set(selectedStations.map((station) => station.name)),
    [selectedStations],
  );
  const visibleEvents = useMemo(
    () =>
      [
        ...games
          .filter(
            (game) =>
              gameMatchesKind(game, selectedKinds) &&
              (selectedStationIds.length === 0 || selectedStationIds.includes(game.station.id)),
          )
          .map((game) => ({ type: 'GAME' as const, startsAt: game.startsAt, game })),
        ...coachGames
          .filter(
            (coachGame) =>
              filterIncludesKind(selectedKinds, 'COACH_GAME') &&
              (selectedStationIds.length === 0 || selectedStationNames.has(coachGame.stationName)),
          )
          .map((coachGame) => ({
            type: 'COACH_GAME' as const,
            startsAt: coachGame.startsAt,
            coachGame,
          })),
        ...tournaments
          .filter(
            (tournament) =>
              filterIncludesKind(selectedKinds, 'TOURNAMENT') &&
              (selectedStationIds.length === 0 ||
                [...selectedStationNames].some(
                  (stationName) =>
                    tournament.venue === stationName ||
                    tournament.venue.startsWith(`${stationName} ·`),
                )),
          )
          .map((tournament) => ({
            type: 'TOURNAMENT' as const,
            startsAt: tournament.startsAt,
            tournament,
          })),
      ].sort((left, right) => {
        const leftId =
          left.type === 'GAME'
            ? left.game.id
            : left.type === 'COACH_GAME'
              ? left.coachGame.id
              : left.tournament.id;
        const rightId =
          right.type === 'GAME'
            ? right.game.id
            : right.type === 'COACH_GAME'
              ? right.coachGame.id
              : right.tournament.id;
        return left.startsAt.localeCompare(right.startsAt) || leftId.localeCompare(rightId);
      }),
    [coachGames, games, selectedKinds, selectedStationIds, selectedStationNames, tournaments],
  );
  const activeFilterCount =
    Number(selectedKinds.length > 0) +
    Number(selectedStationIds.length > 0) +
    Number(!includeFull) +
    Number(levelRange !== 'ALL') +
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
    setLoading(true);
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

  function resetFilters(): void {
    if (activeFilterCount === 0) return;
    beginFilterChange();
    setSelectedKinds([]);
    setSelectedStationIds([]);
    setIncludeFull(true);
    setLevelRange('ALL');
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
          ? await gateway.joinGame(game.id, game.revision)
          : action === 'JOIN_WAITLIST'
            ? await gateway.joinGameWaitlist(game.id)
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
    } catch (cause) {
      setError(errorMessage(cause));
      setReloadToken((current) => current + 1);
    } finally {
      setBusyGameId(null);
    }
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
            onSubmit={submitResult}
            onTabChange={setDetailTab}
          />
        ) : null}
        <MainBottomNavigation active="games" gamesDestination="games" />
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
            <span>Выберите станцию, время и откройте набор игроков</span>
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
                  {!includeFull ? (
                    <button
                      type="button"
                      aria-label="Убрать фильтр Только со свободными местами"
                      onClick={() => {
                        beginFilterChange();
                        setIncludeFull(true);
                      }}
                    >
                      Есть места <span>×</span>
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
                  {levelRange !== 'ALL' ? (
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

      <section className="games-list" aria-live="polite" aria-busy={loading}>
        {loading ? (
          <div className="games-loading" role="status">
            Ищем подходящие игры…
          </div>
        ) : null}
        {!loading && visibleEvents.length === 0 ? (
          <div className="games-empty">
            <span aria-hidden="true">◌</span>
            <h2>{tab === 'DISCOVER' ? 'Подходящих событий пока нет' : 'Здесь пока пусто'}</h2>
            <p>
              {tab === 'DISCOVER'
                ? 'Смените дату, тип события или покажите события без свободных мест.'
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
          ) : event.type === 'COACH_GAME' ? (
            <CoachGameSummaryCard
              coachGame={event.coachGame}
              key={`coach-game-${event.coachGame.id}`}
            />
          ) : (
            <TournamentSummaryCard
              tournament={event.tournament}
              key={`tournament-${event.tournament.id}`}
            />
          ),
        )}
        {nextCursor ? (
          <button
            className="games-load-more"
            type="button"
            disabled={loadingMore}
            onClick={() => void loadMore()}
          >
            {loadingMore ? 'Загружаем…' : 'Показать ещё'}
          </button>
        ) : null}
      </section>
      <MainBottomNavigation active="games" gamesDestination="games" />
    </main>
  );
}
