import { useEffect, useMemo, useRef, useState } from 'react';

import { GameCard, type GameCardAction, type GameCardModel } from './GameCard.js';
import { MainBottomNavigation } from './HomeDashboardPage.js';
import type {
  AuthGateway,
  GameCard as ViewerGameCard,
  GameCommandResult,
  PublicGameFilters,
} from './auth-gateway.js';

type GamesTab = 'DISCOVER' | 'UPCOMING' | 'HISTORY';
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
      default:
        break;
    }
  }
  return 'Не удалось выполнить действие. Проверьте связь и повторите.';
}

export interface GamesPageProps {
  readonly gateway: AuthGateway;
  readonly gameId?: string;
}

export function GamesPage({ gateway, gameId }: GamesPageProps): React.JSX.Element {
  const [tab, setTab] = useState<GamesTab>('DISCOVER');
  const [kind, setKind] = useState<GameKindFilter>('ALL');
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [includeFull, setIncludeFull] = useState(true);
  const [games, setGames] = useState<readonly GameCardModel[]>([]);
  const [detail, setDetail] = useState<ViewerGameCard | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [busyGameId, setBusyGameId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const pendingViewerGame = useRef<ViewerGameCard | null>(null);

  const days = useMemo(
    () =>
      Array.from({ length: 7 }, (_, index) => {
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

  async function handleAction(action: GameCardAction, game: GameCardModel): Promise<void> {
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

  if (gameId) {
    return (
      <main className="games-page games-page--detail">
        <header className="games-header">
          <a className="games-back" href="/games" aria-label="Назад к играм">
            ←
          </a>
          <div>
            <span>ПаделХАБ</span>
            <h1>Игра</h1>
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
          <section className="game-detail" aria-label="Карточка игры">
            <GameCard
              game={detail}
              busy={busyGameId === detail.id}
              onAction={(action, game) => void handleAction(action, game)}
              unsupportedActionBehavior="DISABLED"
            />
            <div className="game-detail__roster">
              <div>
                <span>Состав</span>
                <strong>
                  {detail.capacity.occupied}/{detail.capacity.total}
                </strong>
              </div>
              {detail.participants.map((participant) => (
                <a href={`/profile/${participant.userId}`} key={participant.userId}>
                  <span>{participant.displayName.slice(0, 1).toUpperCase()}</span>
                  <strong>{participant.displayName}</strong>
                  <small>
                    {participant.role === 'ORGANIZER'
                      ? 'Организатор'
                      : (participant.level ?? 'Игрок')}
                  </small>
                </a>
              ))}
              {Array.from({ length: detail.capacity.open }, (_, index) => (
                <div className="game-detail__open-seat" key={`seat-${index}`}>
                  <span>＋</span>
                  <strong>Свободное место</strong>
                  <small>Можно присоединиться</small>
                </div>
              ))}
            </div>
          </section>
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
          <h1>Игры</h1>
        </div>
        <span className="games-header__spacer" aria-hidden="true" />
      </header>

      <nav className="games-tabs" aria-label="Разделы игр">
        {(
          [
            ['DISCOVER', 'Найти игру'],
            ['UPCOMING', 'Мои игры'],
            ['HISTORY', 'История'],
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
            <div className="games-date-rail">
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
