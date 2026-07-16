import type { HomeDashboard } from './auth-gateway.js';
import locationSeligerUrl from './assets/home/location-seliger.png';
import player1Url from './assets/home/player-1.png';
import player2Url from './assets/home/player-2.png';
import player3Url from './assets/home/player-3.png';
import player4Url from './assets/home/player-4.png';
import profileUrl from './assets/home/profile.png';
import promoUrl from './assets/home/promo.png';

interface HomeDashboardPageProps {
  readonly dashboard: HomeDashboard;
  readonly tenantName: string;
  readonly logoutBusy: boolean;
  readonly error?: string | null;
  readonly onLogout: () => void;
}

type GlyphName =
  | 'home'
  | 'ball'
  | 'trophy'
  | 'person'
  | 'people'
  | 'sticker'
  | 'chat'
  | 'profile'
  | 'bell'
  | 'wallet'
  | 'plus';

function Glyph({ name }: { readonly name: GlyphName }): React.JSX.Element {
  const common = {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.9,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };
  switch (name) {
    case 'home':
      return (
        <svg {...common}>
          <path d="m4 10 8-6 8 6v9H4z" />
          <path d="M9.5 19v-5h5v5" />
        </svg>
      );
    case 'ball':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8.5" />
          <path d="M7.6 8.8c2.8 1.6 6 1.6 8.8 0M7.6 15.2c2.8-1.6 6-1.6 8.8 0" />
        </svg>
      );
    case 'trophy':
      return (
        <svg {...common}>
          <path d="M8 4h8v5c0 3-1.7 5-4 5s-4-2-4-5zM12 14v4M8.5 20h7" />
          <path d="M8 6H5v1.5c0 2.2 1.1 3.5 3.2 3.8M16 6h3v1.5c0 2.2-1.1 3.5-3.2 3.8" />
        </svg>
      );
    case 'person':
      return (
        <svg {...common}>
          <circle cx="10" cy="7" r="3" />
          <path d="M4.5 18c.4-4 2.2-6 5.5-6 1.9 0 3.4.8 4.3 2.5M16 5l4 4-6 6-3-3z" />
        </svg>
      );
    case 'people':
      return (
        <svg {...common}>
          <circle cx="9" cy="8" r="3" />
          <circle cx="17" cy="9" r="2" />
          <path d="M3.5 19c.4-4 2.2-6 5.5-6s5.1 2 5.5 6M15 14c3-.4 5 1.3 5.5 4" />
        </svg>
      );
    case 'sticker':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8.5" />
          <path d="M8 10.5h.01M16 10.5h.01M8.5 15c2.3 1.7 4.7 1.7 7 0" />
        </svg>
      );
    case 'chat':
      return (
        <svg {...common}>
          <path d="M4 5.5h16v11H9l-5 3z" />
        </svg>
      );
    case 'profile':
      return (
        <svg {...common}>
          <circle cx="12" cy="8" r="3.5" />
          <path d="M5 20c.5-4.5 2.8-6.5 7-6.5s6.5 2 7 6.5" />
        </svg>
      );
    case 'bell':
      return (
        <svg {...common}>
          <path d="M6.5 17h11l-1.3-2.3V10a4.2 4.2 0 0 0-8.4 0v4.7zM10 19.2c.5.8 1.1 1.2 2 1.2s1.5-.4 2-1.2" />
        </svg>
      );
    case 'wallet':
      return (
        <svg {...common}>
          <path d="M4 7h15v11H4zM5.5 7V5h10v2M15 11h5v4h-5z" />
        </svg>
      );
    case 'plus':
      return (
        <svg {...common}>
          <path d="M12 5v14M5 12h14" />
        </svg>
      );
  }
}

function Chevron(): React.JSX.Element {
  return <span className="fh-chevron" aria-hidden="true" />;
}

function communityInitials(title: string): string {
  return title
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.slice(0, 1).toLocaleUpperCase('ru-RU'))
    .join('');
}

function CommunityLogo({
  community,
}: {
  readonly community: HomeDashboard['communities'][number];
}): React.JSX.Element {
  return (
    <span className="fh-community-logo" style={{ borderColor: community.accent }}>
      {community.logoUrl ? (
        <img src={community.logoUrl} alt="" />
      ) : (
        <i style={{ backgroundColor: community.accent }}>
          <span>{communityInitials(community.title)}</span>
          <svg viewBox="0 0 32 32" aria-hidden="true">
            <path d="M7.5 10.5h17M6.5 15.5h19M7.5 20.5h17" />
            <circle cx="10" cy="8" r="1" />
            <circle cx="16" cy="8" r="1" />
            <circle cx="22" cy="8" r="1" />
          </svg>
        </i>
      )}
      <b aria-hidden="true">✓</b>
    </span>
  );
}

const actionOrder = ['play', 'tournament', 'individual_training', 'group_training'] as const;

const actionLabels: Record<(typeof actionOrder)[number], string> = {
  play: 'Игры',
  tournament: 'Турниры',
  individual_training: 'Индив. тренировки',
  group_training: 'Групповые тренировки',
};

const actionGlyphs: Record<(typeof actionOrder)[number], GlyphName> = {
  play: 'ball',
  tournament: 'trophy',
  individual_training: 'person',
  group_training: 'people',
};

const dates = [
  ['13', 'пн'],
  ['14', 'вт'],
  ['15', 'ср'],
  ['16', 'чт'],
  ['17', 'пт'],
  ['18', 'сб'],
  ['19', 'вс'],
] as const;

const playerImages = [player1Url, player2Url, player3Url, player4Url];

function EventCard({
  item,
  index,
}: {
  readonly item: HomeDashboard['upcoming'][number] | undefined;
  readonly index: number;
}): React.JSX.Element {
  const isRating = index === 1;
  return (
    <a className="fh-event" href={item?.route ?? '/games'}>
      <time>
        <strong>{isRating ? '14:00' : '12:00'}</strong>
        <span>{isRating ? 'до 15:00' : 'до 13:00'}</span>
      </time>
      <span className="fh-event__main">
        <span className="fh-event__header">
          <span className={`fh-event__tag ${isRating ? 'is-rating' : ''}`}>
            <span aria-hidden="true">{isRating ? '★' : '●'}</span>
            {isRating ? 'Рейтинговая игра' : 'Френдли игра'}
          </span>
          <Chevron />
          <strong>{item?.title ?? (isRating ? 'Название игры #2' : 'Название игры')}</strong>
          <small>Ясенево · Паустовского, 4А</small>
        </span>
        <span className="fh-players" aria-label="Участники игры">
          {playerImages.slice(0, isRating ? 3 : 4).map((src, playerIndex) => (
            <img src={src} alt="" aria-hidden="true" key={`${index}-${playerIndex}`} />
          ))}
          {isRating ? <span className="fh-player-add">+</span> : null}
        </span>
      </span>
    </a>
  );
}

export function HomeDashboardPage({
  dashboard,
  tenantName,
  logoutBusy,
  error,
  onLogout,
}: HomeDashboardPageProps): React.JSX.Element {
  const actions = actionOrder.map((id) => ({
    id,
    route: dashboard.quickActions.find((action) => action.id === id)?.route ?? '/',
  }));
  const balance = new Intl.NumberFormat('ru-RU').format(dashboard.profile.balanceMinor / 100);

  return (
    <div className="figma-home-shell">
      <main className="figma-home" aria-label="Главная">
        <section className="fh-hero">
          <header className="fh-profile-row">
            <a className="fh-profile" href="/profile">
              <img src={dashboard.profile.avatarUrl ?? profileUrl} alt="" />
              <span>
                <h1>{dashboard.profile.displayName}</h1>
                <small>
                  <Glyph name="wallet" />
                  {balance} ₽
                </small>
              </span>
            </a>
            <button className="fh-bell" type="button" aria-label="Уведомления">
              <Glyph name="bell" />
            </button>
          </header>

          {dashboard.capabilities.canViewCommunities ? (
            <section className="fh-hero-communities" aria-labelledby="fh-community-title">
              <header>
                <h2 id="fh-community-title">Сообщества</h2>
                <a href="/communities">Все</a>
              </header>
              <div className="fh-community-track">
                {dashboard.communities.slice(0, 5).map((community) => (
                  <a
                    href={community.route}
                    key={community.id}
                    aria-label={`${community.title}${
                      community.unreadCount > 0
                        ? `, непрочитанных сообщений: ${community.unreadCount}`
                        : ''
                    }`}
                  >
                    <CommunityLogo community={community} />
                    <span>{community.title}</span>
                  </a>
                ))}
              </div>
            </section>
          ) : null}

          <nav className="fh-actions" aria-label="Разделы клуба">
            {actions.map((action) => (
              <a href={action.route} key={action.id}>
                <span className="fh-action-icon">
                  <Glyph name={actionGlyphs[action.id]} />
                </span>
                <span>{actionLabels[action.id]}</span>
                <Chevron />
              </a>
            ))}
          </nav>

          <div className="fh-tabs" role="tablist" aria-label="Раздел записей">
            <button type="button" role="tab" aria-selected="true">
              Мои записи
            </button>
            <button type="button" role="tab" aria-selected="false">
              Абонементы
            </button>
          </div>
        </section>

        <section className="fh-main-box">
          <section className="fh-bookings" aria-label="Мои записи">
            <div className="fh-filters">
              <div className="fh-calendar">
                {dates.map(([date, day], index) => (
                  <button className={index === 1 ? 'is-selected' : ''} type="button" key={date}>
                    <strong>{date}</strong>
                    <small>{day}</small>
                    {index === 6 ? <i /> : null}
                  </button>
                ))}
              </div>
              <div className="fh-filter-pills">
                <button className="is-selected" type="button">
                  Все
                </button>
                <button type="button">Игры</button>
                <button type="button">Тренировки</button>
                <button type="button">Турниры</button>
              </div>
            </div>
            <div className="fh-divider" />
            <EventCard item={dashboard.upcoming[0]} index={0} />
            <div className="fh-divider" />
            <EventCard item={dashboard.upcoming[1]} index={1} />
            <div className="fh-bookings-footer">
              <div className="fh-divider" />
              <a href="/bookings">Все записи</a>
            </div>
          </section>

          <a
            className="fh-promo"
            href={dashboard.promotion?.route ?? '/promotions'}
            aria-label={dashboard.promotion?.title ?? 'Лето. Падел. Дружба.'}
            style={{ backgroundImage: `url(${dashboard.promotion?.imageUrl ?? promoUrl})` }}
          />

          <section className="fh-lower">
            <section className="fh-locations" aria-labelledby="fh-locations-title">
              <div className="fh-section-head">
                <h2 id="fh-locations-title">
                  Локации <span>8</span>
                </h2>
                <a href="/locations">Все</a>
              </div>
              <div className="fh-location-track">
                {dashboard.locations.slice(0, 2).map((location, index) => (
                  <a
                    className={`fh-location-card ${index === 0 ? 'is-reference' : ''}`}
                    href={location.route}
                    key={location.id}
                    aria-label={`${location.title}, ${location.courtCount} кортов`}
                    style={
                      index === 0
                        ? { backgroundImage: `url(${location.imageUrl ?? locationSeligerUrl})` }
                        : undefined
                    }
                  >
                    {index === 0 ? null : (
                      <span>
                        <strong>{location.title}</strong>
                        <small>{location.courtCount} кортов</small>
                      </span>
                    )}
                  </a>
                ))}
              </div>
            </section>

            <nav className="fh-additional" aria-label="Дополнительные разделы">
              {dashboard.additionalLinks.map((link) => (
                <a href={link.route} key={link.id}>
                  <span>{link.title}</span>
                  <Chevron />
                </a>
              ))}
            </nav>
          </section>
        </section>

        <nav className="fh-bottom-nav" aria-label="Основная навигация">
          <a href="/" aria-current="page" aria-label="Главная">
            <Glyph name="home" />
          </a>
          <a href="/games" aria-label="Игры">
            <Glyph name="sticker" />
          </a>
          <a className="fh-create" href="/games/new" aria-label="Создать игру">
            <Glyph name="plus" />
          </a>
          <a href="/chats" aria-label="Чаты">
            <Glyph name="chat" />
          </a>
          <a href="/profile" aria-label="Профиль">
            <Glyph name="profile" />
          </a>
        </nav>

        <button
          className="fh-logout-accessible"
          type="button"
          disabled={logoutBusy}
          onClick={onLogout}
        >
          Выйти
        </button>
        <span className="fh-tenant-accessible">{tenantName}</span>
        {error ? (
          <p className="fh-error" role="alert">
            {error}
          </p>
        ) : null}
      </main>
    </div>
  );
}
