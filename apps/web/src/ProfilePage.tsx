import type {
  PlayerProfileView,
  ProfileActionCapability,
  ProfilePrivacySettings,
  ProfilePrivacyUpdateRequest,
} from '@phub/api-sdk';
import { useState } from 'react';

interface ProfilePageProps {
  readonly profile: PlayerProfileView;
  readonly tenantName: string;
  readonly logoutBusy: boolean;
  readonly privacySettings?: ProfilePrivacySettings | null;
  readonly privacyBusy?: boolean;
  readonly privacyError?: string | null;
  readonly privacyNotice?: string | null;
  readonly error?: string | null;
  readonly onSavePrivacy?: (input: ProfilePrivacyUpdateRequest) => void;
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

function accessTierLabel(tier: PlayerProfileView['access']['tier']): string {
  switch (tier) {
    case 'SELF':
      return 'Личный';
    case 'INTERACTION':
      return 'С доступом';
    case 'EXTENDED':
      return 'Расширенный';
    case 'BASIC':
      return 'Базовый';
  }
}

function lockedActionMessage(capability: ProfileActionCapability): string {
  switch (capability.reason) {
    case 'PROFILE_RESTRICTED':
      return 'Игрок ограничил это действие в настройках профиля.';
    case 'ACCESS_REQUIRED':
      return 'Для этого действия пока нет доступа.';
    default:
      return 'Действие сейчас недоступно.';
  }
}

function ProfileAction({
  title,
  description,
  capability,
}: {
  readonly title: string;
  readonly description: string;
  readonly capability: ProfileActionCapability;
}): React.JSX.Element | null {
  if (capability.status === 'HIDDEN') return null;
  const content = (
    <>
      <span aria-hidden="true">{title === 'Открыть чат' ? '↗' : '✦'}</span>
      <strong>{title}</strong>
      <small>
        {capability.status === 'AVAILABLE' ? description : lockedActionMessage(capability)}
      </small>
    </>
  );

  return capability.status === 'AVAILABLE' && capability.route ? (
    <a className="profile-action" href={capability.route}>
      {content}
    </a>
  ) : (
    <button className="profile-action is-locked" type="button" disabled>
      {content}
    </button>
  );
}

function PrivacySettings({
  settings,
  busy,
  error,
  notice,
  onSave,
}: {
  readonly settings?: ProfilePrivacySettings | null;
  readonly busy: boolean;
  readonly error?: string | null;
  readonly notice?: string | null;
  readonly onSave?: (input: ProfilePrivacyUpdateRequest) => void;
}): React.JSX.Element {
  return (
    <section className="profile-privacy-settings" aria-labelledby="privacy-settings-title">
      <div className="profile-section-heading">
        <span>Настройки профиля</span>
        <h2 id="privacy-settings-title">Кто может связаться</h2>
      </div>
      {!settings ? (
        <p className="profile-privacy-loading" role={error ? 'alert' : 'status'}>
          {error ?? 'Загружаем настройки приватности…'}
        </p>
      ) : (
        <PrivacySettingsForm
          key={`${settings.version}:${settings.contactPolicy}:${settings.chatPolicy}`}
          settings={settings}
          busy={busy}
          {...(error !== undefined ? { error } : {})}
          {...(notice !== undefined ? { notice } : {})}
          {...(onSave !== undefined ? { onSave } : {})}
        />
      )}
    </section>
  );
}

function PrivacySettingsForm({
  settings,
  busy,
  error,
  notice,
  onSave,
}: {
  readonly settings: ProfilePrivacySettings;
  readonly busy: boolean;
  readonly error?: string | null;
  readonly notice?: string | null;
  readonly onSave?: (input: ProfilePrivacyUpdateRequest) => void;
}): React.JSX.Element {
  const [contactAllowed, setContactAllowed] = useState(settings.contactPolicy === 'AUTHORIZED');
  const [chatAllowed, setChatAllowed] = useState(settings.chatPolicy === 'AUTHORIZED');
  const changed =
    contactAllowed !== (settings.contactPolicy === 'AUTHORIZED') ||
    chatAllowed !== (settings.chatPolicy === 'AUTHORIZED');

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSave?.({
          expectedVersion: settings.version,
          contactPolicy: contactAllowed ? 'AUTHORIZED' : 'NOBODY',
          chatPolicy: chatAllowed ? 'AUTHORIZED' : 'NOBODY',
        });
      }}
    >
      <label className="profile-privacy-toggle">
        <span>
          <strong>Запрос на связь</strong>
          <small>Разрешить после серверной проверки доступа</small>
        </span>
        <input
          type="checkbox"
          checked={contactAllowed}
          disabled={busy}
          onChange={(event) => setContactAllowed(event.currentTarget.checked)}
        />
      </label>
      <label className="profile-privacy-toggle">
        <span>
          <strong>Личный чат</strong>
          <small>Разрешить создание прямого чата после серверной проверки</small>
        </span>
        <input
          type="checkbox"
          checked={chatAllowed}
          disabled={busy}
          onChange={(event) => setChatAllowed(event.currentTarget.checked)}
        />
      </label>
      <div className="profile-privacy-save-row">
        <p role={error ? 'alert' : notice ? 'status' : undefined}>{error ?? notice}</p>
        <button type="submit" disabled={busy || !changed || !onSave}>
          {busy ? 'Сохраняем…' : 'Сохранить'}
        </button>
      </div>
    </form>
  );
}

export function ProfilePage({
  profile: view,
  tenantName,
  logoutBusy,
  privacySettings,
  privacyBusy = false,
  privacyError,
  privacyNotice,
  error,
  onSavePrivacy,
  onLogout,
}: ProfilePageProps): React.JSX.Element {
  const { profile, privateAccount, access } = view;
  const isSelf = access.audience === 'SELF';
  const balance = privateAccount
    ? new Intl.NumberFormat('ru-RU', {
        style: 'currency',
        currency: privateAccount.currency,
        maximumFractionDigits: 0,
      }).format(privateAccount.balanceMinor / 100)
    : null;
  const rating = profile.level.value;

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
          <p>{isSelf ? 'Мой профиль' : 'Профиль игрока'}</p>
          <h1>{profile.displayName}</h1>
          {privateAccount?.phoneLast4 ? <small>•••• {privateAccount.phoneLast4}</small> : null}
        </div>
      </section>

      <section className="profile-card" aria-label="Доступные данные профиля">
        {privateAccount ? (
          <div>
            <span>Баланс</span>
            <strong>{balance}</strong>
            <small>Виден только вам</small>
          </div>
        ) : (
          <div>
            <span>Доступ к профилю</span>
            <strong>{accessTierLabel(access.tier)}</strong>
            <small>Определён сервером</small>
          </div>
        )}
        <div>
          <span>Уровень</span>
          <strong>{profile.level.label}</strong>
          <small>
            {profile.level.assessmentRequired
              ? 'Нужна оценка уровня'
              : rating === undefined
                ? 'Рейтинг доступен на следующем уровне'
                : `Рейтинг ${rating.toLocaleString('ru-RU')}`}
          </small>
        </div>
      </section>

      {access.audience === 'OTHER' ? (
        <section className="profile-access-section" aria-labelledby="profile-actions-title">
          <div className="profile-section-heading">
            <span>Возможности</span>
            <h2 id="profile-actions-title">Связаться с игроком</h2>
          </div>
          <div className="profile-actions">
            <ProfileAction
              title="Связаться"
              description="Выбрать доступный способ связи"
              capability={access.contact}
            />
            <ProfileAction
              title="Открыть чат"
              description="Перейти в личный чат ПадлХАБ"
              capability={access.chat}
            />
          </div>
        </section>
      ) : null}

      {isSelf ? (
        <PrivacySettings
          key={privacySettings?.version ?? 'loading'}
          {...(privacySettings !== undefined ? { settings: privacySettings } : {})}
          busy={privacyBusy}
          {...(privacyError !== undefined ? { error: privacyError } : {})}
          {...(privacyNotice !== undefined ? { notice: privacyNotice } : {})}
          {...(onSavePrivacy ? { onSave: onSavePrivacy } : {})}
        />
      ) : null}

      <section className="profile-privacy-note" aria-labelledby="profile-privacy-title">
        <span aria-hidden="true">◎</span>
        <div>
          <h2 id="profile-privacy-title">Приватность и доступ</h2>
          <p>
            {isSelf
              ? 'Другие игроки видят только разрешённые поля. Связь и личный чат открываются после серверной проверки доступа.'
              : 'Это уже отфильтрованный профиль: телефон, баланс и закрытые поля не передаются в браузер.'}
          </p>
        </div>
      </section>

      {error ? (
        <p className="profile-error" role="alert">
          {error}
        </p>
      ) : null}

      {isSelf ? (
        <button className="profile-logout" type="button" disabled={logoutBusy} onClick={onLogout}>
          {logoutBusy ? 'Выходим…' : 'Выйти из аккаунта'}
        </button>
      ) : null}
    </main>
  );
}
