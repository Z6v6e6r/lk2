import type { UserProfile } from './auth-gateway.js';

interface ProfilePageProps {
  readonly profile: UserProfile;
  readonly tenantName: string;
  readonly logoutBusy: boolean;
  readonly error?: string | null;
  readonly onLogout: () => void;
}

function initials(displayName: string): string {
  return displayName
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.slice(0, 1).toLocaleUpperCase('ru-RU'))
    .join('');
}

export function ProfilePage({
  profile,
  tenantName,
  logoutBusy,
  error,
  onLogout,
}: ProfilePageProps): React.JSX.Element {
  const balance = new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency: profile.currency,
    maximumFractionDigits: 0,
  }).format(profile.balanceMinor / 100);

  return (
    <main className="profile-page">
      <section className="profile-hero">
        <header className="profile-toolbar">
          <a href="/" aria-label="Вернуться на Главную">
            ‹
          </a>
          <span>{tenantName}</span>
          <i aria-hidden="true" />
        </header>
        <div className="profile-identity">
          <span className="profile-avatar" aria-hidden="true">
            {profile.avatarUrl ? (
              <img src={profile.avatarUrl} alt="" />
            ) : (
              initials(profile.displayName)
            )}
          </span>
          <p>Профиль игрока</p>
          <h1>{profile.displayName}</h1>
          {profile.phoneLast4 ? <small>•••• {profile.phoneLast4}</small> : null}
        </div>
      </section>

      <section className="profile-card" aria-label="Данные профиля">
        <div>
          <span>Баланс</span>
          <strong>{balance}</strong>
        </div>
        <div>
          <span>Уровень</span>
          <strong>{profile.level.label}</strong>
          <small>
            {profile.level.assessmentRequired
              ? 'Нужна оценка уровня'
              : `Рейтинг ${profile.level.value.toLocaleString('ru-RU')}`}
          </small>
        </div>
      </section>

      {error ? (
        <p className="profile-error" role="alert">
          {error}
        </p>
      ) : null}

      <button className="profile-logout" type="button" disabled={logoutBusy} onClick={onLogout}>
        {logoutBusy ? 'Выходим…' : 'Выйти из аккаунта'}
      </button>
    </main>
  );
}
