import { useEffect, useState } from 'react';

import type { CommunityDirectInvitePreview, CommunityOwnMembershipState } from './auth-gateway.js';

interface CommunityInvitePageProps {
  readonly token: string | null;
  readonly previewInvite: (token: string) => Promise<CommunityDirectInvitePreview>;
  readonly redeemInvite: (
    token: string,
    expectedInviteRevision: number,
    expectedMembershipRevision: number,
  ) => Promise<CommunityOwnMembershipState>;
}

function initials(title: string): string {
  return title
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.slice(0, 1).toLocaleUpperCase('ru-RU'))
    .join('');
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

function inviteErrorMessage(error: unknown): string {
  switch (errorCode(error)) {
    case 'COMMUNITY_DIRECT_INVITE_REQUEST_PENDING':
      return 'Сначала дождитесь решения по уже поданной заявке или отмените её в сообществе.';
    case 'COMMUNITY_DIRECT_INVITE_REDEEM_FORBIDDEN':
      return 'Вступление по этой ссылке для вашего аккаунта недоступно.';
    case 'COMMUNITY_DIRECT_INVITE_REVISION_CONFLICT':
    case 'COMMUNITY_MEMBERSHIP_REVISION_CONFLICT':
      return 'Состояние приглашения изменилось. Откройте ссылку заново.';
    case 'COMMUNITY_DIRECT_INVITE_NOT_FOUND':
      return 'Приглашение недействительно, отозвано или срок его действия истёк.';
    default:
      return 'Не удалось проверить приглашение. Проверьте связь и попробуйте ещё раз.';
  }
}

export function CommunityInvitePage({
  token,
  previewInvite,
  redeemInvite,
}: CommunityInvitePageProps): React.JSX.Element {
  const [preview, setPreview] = useState<CommunityDirectInvitePreview | null>(null);
  const [loading, setLoading] = useState(Boolean(token));
  const [busy, setBusy] = useState(false);
  const [joined, setJoined] = useState(false);
  const [error, setError] = useState<string | null>(
    token ? null : 'Ссылка приглашения неполная или повреждена.',
  );

  useEffect(() => {
    if (!token) return;
    let active = true;
    void previewInvite(token).then(
      (value) => {
        if (!active) return;
        setPreview(value);
        setError(null);
        setLoading(false);
      },
      (cause: unknown) => {
        if (!active) return;
        setPreview(null);
        setError(inviteErrorMessage(cause));
        setLoading(false);
      },
    );
    return () => {
      active = false;
    };
  }, [previewInvite, token]);

  async function confirmMembership(): Promise<void> {
    if (!token || !preview || preview.redeemAction !== 'CONFIRM_MEMBERSHIP') return;
    setBusy(true);
    setError(null);
    try {
      await redeemInvite(token, preview.inviteRevision, preview.membershipRevision);
      setJoined(true);
      setBusy(false);
    } catch (cause: unknown) {
      setError(inviteErrorMessage(cause));
      setBusy(false);
    }
  }

  const redeemAction = joined ? 'OPEN_COMMUNITY' : preview?.redeemAction;

  return (
    <main className="community-invite-page">
      <header className="community-invite-header">
        <a href="/communities" aria-label="Вернуться к сообществам">
          ←
        </a>
        <h1>Приглашение в сообщество</h1>
      </header>

      <section className="community-invite-content" aria-busy={loading || busy}>
        {loading ? (
          <p className="community-directory-status" role="status">
            Проверяем приглашение…
          </p>
        ) : null}

        {preview ? (
          <article className="community-invite-card">
            <div className="community-invite-identity">
              {preview.community.logoUrl ? (
                <img src={preview.community.logoUrl} alt="" />
              ) : (
                <span aria-hidden="true">{initials(preview.community.title)}</span>
              )}
              <div>
                <h2>{preview.community.title}</h2>
                <p>
                  {preview.community.visibility === 'PUBLIC'
                    ? 'Открытое сообщество'
                    : preview.community.visibility === 'HIDDEN'
                      ? 'Скрытое сообщество'
                      : 'Закрытое сообщество'}
                  {preview.community.isVerified ? ' · Подтверждено' : ''}
                </p>
              </div>
            </div>

            {redeemAction === 'OPEN_COMMUNITY' ? (
              <p className="community-invite-status">
                {joined
                  ? 'Готово, вы вступили в сообщество.'
                  : 'Вы уже состоите в этом сообществе.'}
              </p>
            ) : redeemAction === 'REQUEST_PENDING' ? (
              <p className="community-invite-status">
                Ваша заявка уже рассматривается. Сначала дождитесь решения или отмените заявку.
              </p>
            ) : (
              <p className="community-invite-status">
                Подтвердите вступление. Ссылка даёт роль участника и действует до{' '}
                {new Intl.DateTimeFormat('ru-RU', {
                  day: 'numeric',
                  month: 'long',
                  year: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                }).format(new Date(preview.expiresAt))}
                .
              </p>
            )}

            {error ? (
              <p className="community-directory-error" role="alert">
                {error}
              </p>
            ) : null}

            <div className="community-invite-actions">
              {redeemAction === 'CONFIRM_MEMBERSHIP' ? (
                <button type="button" disabled={busy} onClick={() => void confirmMembership()}>
                  {busy ? 'Вступаем…' : 'Вступить в сообщество'}
                </button>
              ) : redeemAction === 'OPEN_COMMUNITY' ? (
                <a
                  className="community-invite-primary-link"
                  href={`/communities/${preview.community.id}`}
                >
                  Открыть сообщество
                </a>
              ) : null}
              <a className="community-invite-secondary-link" href="/communities">
                {redeemAction === 'CONFIRM_MEMBERSHIP' ? 'Отказаться' : 'К сообществам'}
              </a>
            </div>
          </article>
        ) : null}

        {!loading && !preview ? (
          <section className="community-invite-card community-invite-card--error">
            <p className="community-directory-error" role="alert">
              {error}
            </p>
            <a className="community-invite-secondary-link" href="/communities">
              К сообществам
            </a>
          </section>
        ) : null}
      </section>
    </main>
  );
}
