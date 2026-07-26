import { useEffect, useMemo, useRef, useState } from 'react';

import { GameCard, type GameCardAction, type GameCardModel } from './GameCard.js';
import { GameDetailView, type GameDetailTab } from './GameDetailView.js';
import { MainBottomNavigation } from './HomeDashboardPage.js';
import { profileUserIdForParticipant } from './game-participant-profile.js';
import type {
  AuthGateway,
  GameCard as ViewerGameCard,
  GameCommandResult,
  PublicGameCard,
  PublicGameFilters,
} from './auth-gateway.js';

type GamesTab = 'DISCOVER' | 'UPCOMING';

type GameKindFilter = 'ALL' | 'FRIENDLY' | 'RATING';

const weekdayFormatter = new Intl.DateTimeFormat('ru-RU', { weekday: 'short' });
const dayFormatter = new Intl.DateTimeFormat('ru-RU', { day: '2-digit' });

function dateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function dateRange(key: string): { readonly startsFrom: string; readonly startsTo: string } {
  const from = new Date(`${key}T00:00:00`);
  const to = new Date(from);
  to.setDate(to.getDate() + 1);
  return { startsFrom: from.toISOString(), startsTo: to.toISOString() };
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
  readonly detailsOrigin?: 'bookings' | 'games';
}

export function GamesPage({
  gateway,
  gameId,
  detailsOrigin = 'games',
}: GamesPageProps): React.JSX.Element {
  const [tab, setTab] = useState<GamesTab>('DISCOVER');
  const [kind, setKind] = useState<GameKindFilter>('ALL');
  const [selectedDate, setSelectedDate] = useState<string | null>(() => dateKey(new Date()));
  const [includeFull, setIncludeFull] = useState(true);
  const [games, setGames] = useState<readonly GameCardModel[]>([]);
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

    const filters: PublicGameFilters = {
      availability: includeFull ? 'INCLUDE_FULL' : 'JOINABLE',
      limit: 20,
      ...(kind === 'ALL' ? {} : { kind }),
      ...(selectedDate ? dateRange(selectedDate) : {}),
    };
    const request =
      tab === 'DISCOVER'
        ? gateway.listPublicGames(filters)
        : gateway.listMyGames({ scope: tab, limit: 20 });
    void request.then(
      (page) => {
        if (!active) return;
        const pending = tab === 'UPCOMING' ? pendingViewerGame.current : null;
        const hasPending = pending ? page.items.some((item) => item.id === pending.id) : false;
        setGames(pending && !hasPending ? [pending, ...page.items] : page.items);
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
  }, [gameId, gateway, includeFull, kind, reloadToken, selectedDate, tab]);

  async function loadMore(): Promise<void> {
    if (!nextCursor || loadingMore || gameId) return;
    setLoadingMore(true);
    setError(null);
    try {
      const page =
        tab === 'DISCOVER'
          ? await gateway.listPublicGames({
              availability: includeFull ? 'INCLUDE_FULL' : 'JOINABLE',
              limit: 20,
              cursor: nextCursor,
              ...(kind === 'ALL' ? {} : { kind }),
              ...(selectedDate ? dateRange(selectedDate) : {}),
            })
          : await gateway.listMyGames({ scope: tab, limit: 20, cursor: nextCursor });
      setGames((current) => [...current, ...page.items]);
      setNextCursor(page.nextCursor ?? null);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoadingMore(false);
    }
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
    const detailsBackHref = detailsOrigin === 'bookings' ? '/bookings' : '/games';
    const detailsBackLabel = detailsOrigin === 'bookings' ? 'Назад к записям' : 'Назад к играм';
    return (
      <main className="games-page games-page--detail">
        <header className="games-header">
          <a className="games-back" href={detailsBackHref} aria-label={detailsBackLabel}>
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
        <MainBottomNavigation
          active="games"
          gamesDestination={detailsOrigin === 'bookings' ? 'bookings' : 'games'}
        />
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
                  setLoading(true);
                  setError(null);
                  setSelectedDate(null);
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
                    setLoading(true);
                    setError(null);
                    setSelectedDate(day.key);
                  }}
                >
                  <strong>{day.day}</strong>
                  <span>{day.weekday}</span>
                </button>
              ))}
            </div>
            <div className="games-filter-row">
              {(
                [
                  ['ALL', 'Все игры'],
                  ['FRIENDLY', 'Френдли'],
                  ['RATING', 'Рейтинговые'],
                ] as const
              ).map(([value, label]) => (
                <button
                  className={kind === value ? 'is-active' : undefined}
                  type="button"
                  key={value}
                  aria-pressed={kind === value}
                  onClick={() => {
                    if (kind === value) return;
                    setLoading(true);
                    setError(null);
                    setKind(value);
                  }}
                >
                  {label}
                </button>
              ))}
              <label>
                <input
                  type="checkbox"
                  checked={includeFull}
                  onChange={(event) => {
                    setLoading(true);
                    setError(null);
                    setIncludeFull(event.target.checked);
                  }}
                />
                Показывать набранные
              </label>
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
        {!loading && games.length === 0 ? (
          <div className="games-empty">
            <span aria-hidden="true">◌</span>
            <h2>{tab === 'DISCOVER' ? 'Подходящих игр пока нет' : 'Здесь пока пусто'}</h2>
            <p>
              {tab === 'DISCOVER'
                ? 'Смените дату или покажите игры с набранным составом.'
                : 'После записи игра появится в этом разделе.'}
            </p>
          </div>
        ) : null}
        {games.map((game) => (
          <GameCard
            game={game}
            busy={busyGameId === game.id}
            key={game.id}
            onAction={(action, selectedGame) => void handleAction(action, selectedGame)}
            onParticipantProfileRequest={(selectedGame, participant, participantIndex) =>
              void handleParticipantProfileRequest(selectedGame, participant, participantIndex)
            }
          />
        ))}
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
