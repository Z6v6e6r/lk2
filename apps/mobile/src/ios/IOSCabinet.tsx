import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { AuthenticatedSession, PublicGameCardPage } from '@phub/api-sdk';
import {
  HomeDashboardPage,
  MainBottomNavigation,
  UpcomingBookingCard,
} from '../../../web/src/HomeDashboardPage.js';
import type {
  HomeSectionEnvelope,
  MainNavigationSection,
} from '../../../web/src/HomeDashboardPage.js';
import { ProfilePage } from '../../../web/src/ProfilePage.js';
import { LocationsPage } from '../../../web/src/LocationsPage.js';
import { LocationDetailPage } from '../../../web/src/LocationDetailPage.js';
import { GameCard } from '../../../web/src/GameCard.js';
import { ActivityHistoryPanel } from '../../../web/src/ActivityHistory.js';
import { createCabinetData, selfProfile } from './cabinet-data.js';
import type { CabinetData } from './cabinet-data.js';
import { useCabinetRoute } from './cabinet-navigation.js';
import type { IOSSession } from './session.js';
import '../../../web/src/styles.css';
import '../styles.css';
import './cabinet.css';

const unavailable = 'Не удалось загрузить данные. Проверьте связь и попробуйте ещё раз.';
type Query<T> = {
  readonly value: T | null;
  readonly error: string | null;
  readonly loading: boolean;
  readonly receivedAt: number;
  readonly retry: () => void;
};

function useQuery<T>(load: () => Promise<T>): Query<T> {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{
    load: () => Promise<T>;
    attempt: number;
    query: Omit<Query<T>, 'retry'>;
  } | null>(null);
  useEffect(() => {
    let active = true;
    void load().then(
      (value) => {
        if (active)
          setResult({
            load,
            attempt,
            query: { value, error: null, loading: false, receivedAt: Date.now() },
          });
      },
      () => {
        if (active)
          setResult({
            load,
            attempt,
            query: { value: null, error: unavailable, loading: false, receivedAt: Date.now() },
          });
      },
    );
    return () => {
      active = false;
    };
  }, [load, attempt]);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  return {
    ...(result?.load === load && result.attempt === attempt
      ? result.query
      : { value: null, error: null, loading: true, receivedAt: 0 }),
    retry,
  };
}

function Navigation({ active }: { readonly active?: MainNavigationSection }): React.JSX.Element {
  return <MainBottomNavigation readOnly {...(active ? { active } : {})} />;
}

function Page({
  title,
  children,
  active,
}: {
  readonly title: string;
  readonly children: ReactNode;
  readonly active?: MainNavigationSection;
}): React.JSX.Element {
  return (
    <main className="games-page ios-cabinet-page">
      <header className="ios-cabinet-heading">
        <a href="/" aria-label="На главную">
          ←
        </a>
        <h1>{title}</h1>
      </header>
      {children}
      <Navigation {...(active ? { active } : {})} />
    </main>
  );
}

function QueryResult<T>({
  query,
  children,
}: {
  readonly query: Query<T>;
  readonly children: (value: T) => ReactNode;
}): React.JSX.Element {
  if (query.loading) return <p role="status">Загружаем…</p>;
  if (query.error || query.value === null)
    return (
      <div className="ios-cabinet-error">
        <p role="alert">{query.error ?? unavailable}</p>
        <button type="button" onClick={query.retry}>
          Повторить
        </button>
      </div>
    );
  return <>{children(query.value)}</>;
}

function Load<T>({
  load,
  title,
  children,
}: {
  readonly load: () => Promise<T>;
  readonly title: string;
  readonly children: (value: T) => ReactNode;
}): React.JSX.Element {
  const query = useQuery(load);
  return query.value === null ? (
    <Page title={title}>
      <QueryResult query={query}>{children}</QueryResult>
    </Page>
  ) : (
    <>{children(query.value)}</>
  );
}

function section<T>(query: Query<T>, stale = false): HomeSectionEnvelope<T> | null {
  return query.value !== null
    ? { state: stale ? 'STALE' : 'READY', value: query.value }
    : query.error
      ? { state: 'UNAVAILABLE', message: query.error }
      : null;
}

function Home({
  data,
  auth,
  onLogout,
}: {
  readonly data: CabinetData;
  readonly auth: AuthenticatedSession;
  readonly onLogout: () => void;
}): React.JSX.Element {
  const home = useQuery(data.home);
  const viewer = useQuery(data.profile);
  const bookings = useQuery(data.bookings);
  if (home.value === null)
    return (
      <Page title="Главная" active="home">
        <QueryResult query={home}>{() => null}</QueryResult>
        <button type="button" onClick={onLogout}>
          Выйти из аккаунта
        </button>
      </Page>
    );
  return (
    <QueryResult query={home}>
      {(dashboard) => (
        <HomeDashboardPage
          dashboard={dashboard}
          viewerFallback={auth.user}
          viewer={section(viewer)}
          upcoming={section(
            bookings,
            Boolean(
              bookings.value?.staleAt && Date.parse(bookings.value.staleAt) < bookings.receivedAt,
            ),
          )}
          tenantName="ПадлХАБ"
          layoutVariant="v3"
          notificationUnreadCount={0}
          notificationsAvailable={false}
          dateRecommendationsAvailable={false}
          navigation={<Navigation active="home" />}
          loadCommunityPage={data.communities}
          loadBookingRecommendations={data.recommendations}
          loadActivityHistory={data.history}
          logoutBusy={false}
          onRetryViewer={viewer.retry}
          onRetryUpcoming={bookings.retry}
          onLogout={onLogout}
        />
      )}
    </QueryResult>
  );
}

function Profile({
  data,
  origin,
  onLogout,
}: {
  readonly data: CabinetData;
  readonly origin: string;
  readonly onLogout: () => void;
}): React.JSX.Element {
  const profile = useQuery(data.profile);
  const dashboard = useQuery(data.dashboard);
  const preferences = useQuery(data.preferences);
  const privacy = useQuery(data.privacy);
  if (profile.value === null)
    return (
      <Page title="Профиль" active="profile">
        <QueryResult query={profile}>{() => null}</QueryResult>
        <button type="button" onClick={onLogout}>
          Выйти из аккаунта
        </button>
      </Page>
    );
  return (
    <QueryResult query={profile}>
      {(value) => (
        <ProfilePage
          profile={selfProfile(value)}
          logoutBusy={false}
          onLogout={onLogout}
          navigation={<Navigation active="profile" />}
          publicProfileOrigin={origin}
          notificationsAvailable={false}
          subscriptions={dashboard.value?.subscriptions ?? null}
          friendsAvailable={false}
          subscriptionRenewalAvailable={false}
          subscriptionsError={dashboard.error}
          communities={dashboard.value ? { items: dashboard.value.communities } : null}
          communitiesError={dashboard.error}
          bookingPreferences={preferences.value}
          bookingPreferencesBusy={preferences.loading}
          bookingPreferencesError={preferences.error}
          privacySettings={privacy.value}
          privacyBusy={privacy.loading}
          privacyError={privacy.error}
          stationChoices={
            dashboard.value?.locations.map((location) => ({
              id: location.id,
              name: location.title,
            })) ?? []
          }
        />
      )}
    </QueryResult>
  );
}

function Bookings({ data }: { readonly data: CabinetData }): React.JSX.Element {
  const query = useQuery(data.bookings);
  return (
    <Page title="Мои записи" active="games">
      <nav className="ios-cabinet-links" aria-label="Разделы записей">
        <a href="/games">Найти игру</a>
        <a href="/history">История посещений</a>
      </nav>
      <QueryResult query={query}>
        {(bookings) => (
          <>
            {bookings.staleAt && Date.parse(bookings.staleAt) < query.receivedAt ? (
              <p role="status">Данные могут быть неактуальны.</p>
            ) : null}
            {bookings.items.length ? (
              <div className="fh-bookings-list">
                {bookings.items.map((item) => (
                  <UpcomingBookingCard key={item.id} item={item} />
                ))}
              </div>
            ) : (
              <p role="status">Ближайших записей нет.</p>
            )}
          </>
        )}
      </QueryResult>
    </Page>
  );
}

function Games({ data }: { readonly data: CabinetData }): React.JSX.Element {
  const [kind, setKind] = useState<'ALL' | 'COACH_GAME'>('ALL');
  const load = useCallback(
    () =>
      data.games({ limit: 20, availability: 'INCLUDE_FULL', ...(kind === 'ALL' ? {} : { kind }) }),
    [data, kind],
  );
  const query = useQuery(load);
  const [more, setMore] = useState<PublicGameCardPage | null>(null);
  const [moreError, setMoreError] = useState(false);
  const [busy, setBusy] = useState(false);
  const page = more ?? query.value;
  // Filters are locked while a cursor is loading, so pages cannot cross filter snapshots.
  async function next(): Promise<void> {
    if (busy || !page?.nextCursor) return;
    setBusy(true);
    setMoreError(false);
    try {
      const next = await data.games({
        limit: 20,
        availability: 'INCLUDE_FULL',
        cursor: page.nextCursor,
        ...(kind === 'ALL' ? {} : { kind }),
      });
      setMore({
        ...next,
        items: [
          ...page.items,
          ...next.items.filter((game) => !page.items.some((item) => item.id === game.id)),
        ],
      });
    } catch {
      setMoreError(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Page title="Игры" active="games">
      <p className="ios-cabinet-note">
        Пока доступен просмотр игр. Запись и оплата появятся в следующей версии.
      </p>
      <label className="ios-cabinet-filter">
        Тип игры
        <select
          value={kind}
          disabled={busy}
          onChange={(event) => {
            setMore(null);
            setMoreError(false);
            setKind(event.target.value as typeof kind);
          }}
        >
          <option value="ALL">Все игры</option>
          <option value="COACH_GAME">Игры с тренером</option>
        </select>
      </label>
      <QueryResult query={query}>
        {() => (
          <>
            {page?.items.length ? (
              <div className="ios-cabinet-cards">
                {page.items.map((game) => (
                  <GameCard key={game.id} game={game} readOnly />
                ))}
              </div>
            ) : (
              <p role="status">Открытых игр пока нет.</p>
            )}
            {moreError ? (
              <p role="alert">Не удалось загрузить следующую страницу. Попробуйте ещё раз.</p>
            ) : null}
            {page?.nextCursor ? (
              <button type="button" disabled={busy} onClick={() => void next()}>
                {busy ? 'Загружаем…' : moreError ? 'Повторить' : 'Показать ещё'}
              </button>
            ) : null}
          </>
        )}
      </QueryResult>
    </Page>
  );
}

function Subscriptions({ data }: { readonly data: CabinetData }): React.JSX.Element {
  const query = useQuery(data.dashboard);
  return (
    <Page title="Мои абонементы" active="profile">
      <QueryResult query={query}>
        {(dashboard) => (
          <>
            {dashboard.subscriptions.length ? (
              <div className="ios-cabinet-cards">
                {dashboard.subscriptions.map((subscription) => (
                  <article className="ios-cabinet-subscription" key={subscription.id}>
                    <h2>{subscription.title}</h2>
                    <p>
                      {
                        {
                          active: 'Активен',
                          scheduled: 'Ещё не начался',
                          paused: 'Приостановлен',
                          exhausted: 'Занятия закончились',
                          expired: 'Истёк',
                        }[subscription.status]
                      }
                    </p>
                    <p>Осталось занятий: {subscription.remainingUnits}</p>
                    {subscription.validUntil ? (
                      <p>
                        Действует до{' '}
                        {new Date(subscription.validUntil).toLocaleDateString('ru-RU', {
                          timeZone: 'Europe/Moscow',
                        })}
                      </p>
                    ) : null}
                  </article>
                ))}
              </div>
            ) : (
              <p role="status">Абонементов пока нет.</p>
            )}
          </>
        )}
      </QueryResult>
    </Page>
  );
}

export function IOSCabinet({
  session,
  auth,
}: {
  readonly session: IOSSession;
  readonly auth: AuthenticatedSession;
}): React.JSX.Element {
  const route = useCabinetRoute();
  const data = useMemo(() => createCabinetData(session, auth.user.id), [session, auth.user.id]);
  const path = route.split('?')[0]!;
  const detail =
    /^\/(locations|games)\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.exec(
      path,
    );
  const logout = () => {
    void session.logout();
  };
  let content: ReactNode;
  if (path === '/') content = <Home data={data} auth={auth} onLogout={logout} />;
  else if (path === '/profile' || path === `/profile/${auth.user.id}`)
    content = <Profile data={data} origin={session.configuration.apiBaseUrl} onLogout={logout} />;
  else if (path === '/bookings') content = <Bookings data={data} />;
  else if (path === '/games') content = <Games data={data} />;
  else if (path === '/history')
    content = (
      <Page title="История посещений" active="games">
        <ActivityHistoryPanel active loadHistory={data.history} />
      </Page>
    );
  else if (path === '/subscriptions' || /^\/subscriptions\/[a-f0-9-]{36}$/i.test(path))
    content = <Subscriptions data={data} />;
  else if (path === '/locations')
    content = (
      <Load title="Локации" load={data.locations}>
        {(locations) => <LocationsPage locations={locations} navigation={<Navigation />} />}
      </Load>
    );
  else if (detail?.[1] === 'locations')
    content = (
      <Load title="Локация" load={() => data.location(detail[2]!)}>
        {(location) => <LocationDetailPage location={location} navigation={<Navigation />} />}
      </Load>
    );
  else if (detail?.[1] === 'games')
    content = (
      <Load title="Игра" load={() => data.game(detail[2]!)}>
        {(game) => (
          <Page title="Игра" active="games">
            <GameCard game={game} readOnly />
            <p className="ios-cabinet-note">
              Запись, оплата и управление игрой появятся в следующей версии.
            </p>
          </Page>
        )}
      </Load>
    );
  else
    content = (
      <Page title="Раздел пока недоступен">
        <p>Этот раздел ещё не подключён в приложении.</p>
        <a href="/">Вернуться на главную</a>
      </Page>
    );
  return (
    <div className="ios-cabinet">
      <div key={path}>{content}</div>
    </div>
  );
}
