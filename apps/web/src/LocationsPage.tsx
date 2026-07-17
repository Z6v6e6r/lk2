import type { LocationList } from './auth-gateway.js';

function LocationNavigation(): React.JSX.Element {
  return (
    <nav className="location-bottom-nav" aria-label="Основная навигация">
      <a href="/" aria-label="Главная">
        ⌂
      </a>
      <a href="/games" aria-label="Игры">
        ◯
      </a>
      <a className="is-create" href="/games/new" aria-label="Создать игру">
        ＋
      </a>
      <a href="/chats" aria-label="Чаты">
        ▢
      </a>
      <a href="/profile" aria-label="Профиль">
        ♙
      </a>
    </nav>
  );
}

export function LocationsPage({
  locations,
}: {
  readonly locations: LocationList;
}): React.JSX.Element {
  return (
    <main className="location-directory-shell">
      <header className="location-directory-header">
        <a href="/" aria-label="Вернуться на Главную">
          ‹
        </a>
        <div>
          <span>Где играем</span>
          <h1>Локации</h1>
        </div>
        <span className="location-directory-count">{locations.items.length}</span>
      </header>

      <section className="location-directory-list" aria-label="Список локаций">
        {locations.items.map((location) => (
          <a className="location-directory-card" href={location.route} key={location.id}>
            <span
              className="location-directory-image"
              style={
                location.coverImageUrl
                  ? { backgroundImage: `url(${location.coverImageUrl})` }
                  : undefined
              }
            >
              <i>
                {location.courtCount} {location.courtCount === 1 ? 'корт' : 'кортов'}
              </i>
            </span>
            <span className="location-directory-copy">
              <small>{location.city ?? 'ПаделХАБ'}</small>
              <strong>{location.title}</strong>
              <i>
                Открыть карточку <b>→</b>
              </i>
            </span>
          </a>
        ))}
        {locations.items.length === 0 ? (
          <div className="location-directory-empty">
            <span>⌖</span>
            <h2>Станции готовятся к публикации</h2>
            <p>Как только администратор опубликует карточку, она появится здесь и на Главной.</p>
          </div>
        ) : null}
      </section>
      <LocationNavigation />
    </main>
  );
}

export { LocationNavigation };
