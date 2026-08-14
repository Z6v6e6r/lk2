import { useEffect, useState } from 'react';

import { CommunityFeed, type CommunityFeedProps } from './CommunityFeed.js';
import { CommunityInviteManagement } from './CommunityInviteManagement.js';
import { createCommunityDurableEventController } from './community-durable-event-controller.js';
import type { CommunityRealtimeTransport } from './community-realtime-transport.js';
import type {
  AuthGateway,
  CommunityDetailView,
  CommunityDirectInviteCreated,
  CommunityDirectInvitePage,
  CommunityDirectInviteState,
  CommunityFeedPage,
  CommunityOwnMembershipState,
} from './auth-gateway.js';

interface CommunityDetailPageProps
  extends
    Pick<
      CommunityFeedProps,
      | 'loadFeed'
      | 'issueMediaUpload'
      | 'finalizeMediaUpload'
      | 'getMediaStatus'
      | 'createPost'
      | 'loadMediaVariant'
    >,
    Pick<AuthGateway, 'recoverCommunityEvents'> {
  readonly communityId: string;
  readonly communityDirectInvitesEnabled?: boolean;
  readonly realtimeTransport?: CommunityRealtimeTransport;
  readonly loadDetail: (communityId: string) => Promise<CommunityDetailView>;
  readonly loadMembershipState: (communityId: string) => Promise<CommunityOwnMembershipState>;
  readonly joinOrRequestMembership: (
    communityId: string,
    expectedMembershipRevision: number,
  ) => Promise<CommunityOwnMembershipState>;
  readonly cancelJoinRequest: (
    communityId: string,
    requestId: string,
    expectedMembershipRevision: number,
    expectedRequestRevision: number,
  ) => Promise<CommunityOwnMembershipState>;
  readonly leaveMembership: (
    communityId: string,
    expectedMembershipRevision: number,
  ) => Promise<CommunityOwnMembershipState>;
  readonly loadInvites: (
    communityId: string,
    cursor?: string,
  ) => Promise<CommunityDirectInvitePage>;
  readonly createInvite: (
    communityId: string,
    expectedIssuerMembershipRevision: number,
  ) => Promise<CommunityDirectInviteCreated>;
  readonly revokeInvite: (
    inviteId: string,
    expectedInviteRevision: number,
  ) => Promise<CommunityDirectInviteState>;
}

type MembershipCommand = 'join' | 'cancel' | 'leave';

function initials(title: string): string {
  return title
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.slice(0, 1).toLocaleUpperCase('ru-RU'))
    .join('');
}

function joinActionLabel(action: CommunityDetailView['joinAction']): string {
  switch (action) {
    case 'JOIN_NOW':
      return 'Можно вступить сразу';
    case 'REQUEST_TO_JOIN':
      return 'Вступление по заявке';
    case 'REQUEST_REJOIN':
      return 'Можно запросить повторное вступление';
    case 'INVITE_REQUIRED':
      return 'Нужно приглашение';
    case 'MEMBERSHIP_PENDING':
      return 'Заявка рассматривается';
    case 'OPEN_COMMUNITY':
      return 'Вы участник сообщества';
    case 'UNAVAILABLE':
      return 'Вступление недоступно';
  }
}

function visibilityLabel(visibility: CommunityDetailView['visibility']): string {
  switch (visibility) {
    case 'PUBLIC':
      return 'Открытое';
    case 'LISTED_PRIVATE':
      return 'Закрытое';
    case 'HIDDEN':
      return 'Скрытое';
  }
}

export function CommunityDetailPage({
  communityId,
  communityDirectInvitesEnabled = false,
  loadDetail,
  loadMembershipState,
  joinOrRequestMembership,
  cancelJoinRequest,
  leaveMembership,
  loadInvites,
  createInvite,
  revokeInvite,
  loadFeed,
  issueMediaUpload,
  finalizeMediaUpload,
  getMediaStatus,
  createPost,
  loadMediaVariant,
  recoverCommunityEvents,
  realtimeTransport,
}: CommunityDetailPageProps): React.JSX.Element {
  const [detail, setDetail] = useState<CommunityDetailView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [membershipState, setMembershipState] = useState<CommunityOwnMembershipState | null>(null);
  const [membershipLoading, setMembershipLoading] = useState(true);
  const [membershipError, setMembershipError] = useState<string | null>(null);
  const [commandBusy, setCommandBusy] = useState<MembershipCommand | null>(null);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [canonicalFeedSnapshot, setCanonicalFeedSnapshot] = useState<{
    readonly revision: number;
    readonly page: CommunityFeedPage;
  }>();
  const [realtimeNotice, setRealtimeNotice] = useState<string>();

  useEffect(() => {
    let active = true;
    void loadDetail(communityId).then(
      (value) => {
        if (active) setDetail(value);
      },
      () => {
        if (active) setError('Сообщество недоступно или не найдено.');
      },
    );
    return () => {
      active = false;
    };
  }, [communityId, loadDetail]);

  useEffect(() => {
    let active = true;
    void loadMembershipState(communityId).then(
      (value) => {
        if (!active) return;
        setMembershipState(value);
        setMembershipLoading(false);
      },
      () => {
        if (!active) return;
        setMembershipError('Не удалось проверить состояние участия. Обновите страницу.');
        setMembershipLoading(false);
      },
    );
    return () => {
      active = false;
    };
  }, [communityId, loadMembershipState]);

  useEffect(() => {
    if (!realtimeTransport || membershipState?.membershipStatus !== 'ACTIVE') {
      return;
    }
    let active = true;
    let seeded = false;
    let snapshotRevision = 0;
    let operationTail = Promise.resolve();

    const refreshCanonicalState = async (): Promise<void> => {
      const [nextDetail, nextFeed] = await Promise.all([
        loadDetail(communityId),
        loadFeed(communityId),
      ]);
      if (!active) return;
      snapshotRevision += 1;
      setDetail(nextDetail);
      setCanonicalFeedSnapshot({ revision: snapshotRevision, page: nextFeed });
      setError(null);
      setRealtimeNotice(undefined);
    };

    const controller = createCommunityDurableEventController({
      gateway: { recoverCommunityEvents },
      onCanonicalEventBatch: refreshCanonicalState,
      reloadCanonicalState: refreshCanonicalState,
    });

    const serialize = (operation: () => Promise<void>): Promise<void> => {
      const next = operationTail.then(operation);
      operationTail = next.catch(() => undefined);
      return next.catch((error: unknown) => {
        if (active) {
          setRealtimeNotice(
            'Обновление в реальном времени временно недоступно. Лента остаётся доступна по HTTP.',
          );
        }
        throw error;
      });
    };

    let unsubscribe = (): void => undefined;
    try {
      unsubscribe = realtimeTransport.subscribe(communityId, {
        onSubscribed: ({ latestSequence }) =>
          serialize(async () => {
            if (!seeded) {
              // The subscription head is captured before the canonical refresh. Only that order
              // makes the visible snapshot safe to associate with latestSequence.
              await refreshCanonicalState();
              if (!active) return;
              controller.setLastSequence(communityId, latestSequence);
              seeded = true;
              return;
            }
            await controller.handleHint({ communityId, sequence: latestSequence });
          }),
        onHint: (hint) =>
          serialize(async () => {
            if (!seeded) throw new Error('COMMUNITY_REALTIME_NOT_SEEDED');
            await controller.handleHint(hint);
          }),
        onUnavailable: ({ code }) => {
          if (!active || code === 'COMMUNITIES_REALTIME_DISABLED') return;
          setRealtimeNotice(
            'Обновление в реальном времени временно недоступно. Лента остаётся доступна по HTTP.',
          );
        },
      });
    } catch {
      void Promise.resolve().then(() => {
        if (active) {
          setRealtimeNotice(
            'Обновление в реальном времени временно недоступно. Лента остаётся доступна по HTTP.',
          );
        }
      });
    }

    return () => {
      active = false;
      unsubscribe();
      controller.clear();
    };
  }, [
    communityId,
    loadDetail,
    loadFeed,
    membershipState?.membershipStatus,
    realtimeTransport,
    recoverCommunityEvents,
  ]);

  async function refreshDetail(hideCurrent: boolean): Promise<void> {
    if (hideCurrent) setDetail(null);
    try {
      const value = await loadDetail(communityId);
      setDetail(value);
      setError(null);
    } catch {
      if (hideCurrent) setError('Вы покинули сообщество. Теперь оно недоступно.');
    }
  }

  async function runMembershipCommand(
    command: MembershipCommand,
    action: () => Promise<CommunityOwnMembershipState>,
  ): Promise<void> {
    setCommandBusy(command);
    setCommandError(null);
    try {
      const nextState = await action();
      setMembershipState(nextState);
      setConfirmLeave(false);
      await refreshDetail(command === 'leave');
    } catch {
      setCommandError('Не удалось выполнить действие. Состояние не изменено — попробуйте ещё раз.');
    } finally {
      setCommandBusy(null);
    }
  }

  if (!detail) {
    return (
      <main className="community-directory-page">
        <header className="community-directory-header">
          <a href="/communities" aria-label="Вернуться к сообществам">
            ←
          </a>
          <h1>{error ? 'Сообщество недоступно' : 'Загружаем сообщество'}</h1>
        </header>
        <section className="community-directory-content">
          <p className={error ? 'community-directory-error' : 'community-directory-status'}>
            {error ?? 'Проверяем доступ и актуальное состояние…'}
          </p>
        </section>
      </main>
    );
  }

  const full = 'description' in detail;
  const membership = 'viewerMembership' in detail ? detail.viewerMembership : undefined;
  const joinAction = membershipState?.joinAction ?? detail.joinAction;
  const pendingRequest = membershipState?.joinRequest;
  const isOwner = membershipState?.role === 'OWNER';
  const canManageInvites =
    communityDirectInvitesEnabled &&
    membershipState?.membershipStatus === 'ACTIVE' &&
    (membershipState.role === 'OWNER' || membershipState.role === 'ADMIN');
  const canReadFeed = detail.visibility === 'PUBLIC' || membership?.status === 'ACTIVE';
  const canPublish =
    membershipState?.membershipStatus === 'ACTIVE' &&
    membershipState.role !== null &&
    'publishingPreset' in detail &&
    (detail.publishingPreset !== 'STAFF_FEED' || membershipState.role !== 'MEMBER');

  let membershipAction: React.JSX.Element | null = null;
  if (membershipLoading) {
    membershipAction = (
      <p className="community-directory-status" aria-live="polite">
        Проверяем состояние участия…
      </p>
    );
  } else if (membershipError) {
    membershipAction = (
      <p className="community-directory-error" role="alert">
        {membershipError}
      </p>
    );
  } else if (membershipState) {
    switch (joinAction) {
      case 'JOIN_NOW':
      case 'REQUEST_TO_JOIN':
      case 'REQUEST_REJOIN': {
        const label =
          joinAction === 'JOIN_NOW'
            ? 'Вступить'
            : joinAction === 'REQUEST_REJOIN'
              ? 'Запросить повторное вступление'
              : 'Подать заявку';
        membershipAction = (
          <button
            type="button"
            disabled={commandBusy !== null}
            onClick={() =>
              void runMembershipCommand('join', () =>
                joinOrRequestMembership(communityId, membershipState.membershipRevision),
              )
            }
          >
            {commandBusy === 'join' ? 'Отправляем…' : label}
          </button>
        );
        break;
      }
      case 'MEMBERSHIP_PENDING':
        membershipAction = pendingRequest ? (
          <button
            type="button"
            disabled={commandBusy !== null}
            onClick={() =>
              void runMembershipCommand('cancel', () =>
                cancelJoinRequest(
                  communityId,
                  pendingRequest.id,
                  membershipState.membershipRevision,
                  pendingRequest.revision,
                ),
              )
            }
          >
            {commandBusy === 'cancel' ? 'Отменяем…' : 'Отменить заявку'}
          </button>
        ) : (
          <p>Заявка рассматривается. Обновите страницу, чтобы проверить её состояние.</p>
        );
        break;
      case 'OPEN_COMMUNITY':
        if (isOwner) {
          membershipAction = <p>Сначала передайте права владельца другому участнику.</p>;
        } else if (confirmLeave) {
          membershipAction = (
            <div className="community-discovery" role="group" aria-label="Подтверждение выхода">
              <p>После выхода повторное вступление может потребовать разрешения администратора.</p>
              <button
                type="button"
                disabled={commandBusy !== null}
                onClick={() => setConfirmLeave(false)}
              >
                Остаться
              </button>
              <button
                type="button"
                disabled={commandBusy !== null}
                onClick={() =>
                  void runMembershipCommand('leave', () =>
                    leaveMembership(communityId, membershipState.membershipRevision),
                  )
                }
              >
                {commandBusy === 'leave' ? 'Выходим…' : 'Подтвердить выход'}
              </button>
            </div>
          );
        } else {
          membershipAction = (
            <button
              type="button"
              disabled={commandBusy !== null}
              onClick={() => setConfirmLeave(true)}
            >
              Покинуть сообщество
            </button>
          );
        }
        break;
      case 'INVITE_REQUIRED':
        membershipAction = (
          <p>Вступить можно только по приглашению владельца или администратора.</p>
        );
        break;
      case 'UNAVAILABLE':
        membershipAction = (
          <p>
            {membershipState.membershipStatus === 'BANNED'
              ? 'Доступ к вступлению в это сообщество ограничен.'
              : 'Вступление в это сообщество сейчас недоступно.'}
          </p>
        );
        break;
    }
  }

  return (
    <main className="community-directory-page community-detail-page">
      <header className="community-directory-header community-detail-header">
        <a href="/communities" aria-label="Вернуться к сообществам">
          ←
        </a>
        <div className="community-detail-identity">
          <span className="community-detail-logo" aria-hidden="true">
            {detail.logoUrl ? <img src={detail.logoUrl} alt="" /> : initials(detail.title)}
          </span>
          <span>{visibilityLabel(detail.visibility)}</span>
          <h1>{detail.title}</h1>
          {detail.isVerified ? <b>Проверено PadlHub</b> : null}
        </div>
      </header>

      <section className="community-directory-content community-detail-content">
        <div className="community-detail-access">
          <strong>{joinActionLabel(joinAction)}</strong>
          {detail.visibility === 'LISTED_PRIVATE' && !membership ? (
            <p>Описание и число участников видны только активным участникам.</p>
          ) : null}
        </div>

        {membershipAction}
        {commandError ? (
          <p className="community-directory-error" role="alert">
            {commandError}
          </p>
        ) : null}
        {membershipState?.membershipStatus === 'ACTIVE' && realtimeNotice ? (
          <p className="community-directory-status" role="status">
            {realtimeNotice}
          </p>
        ) : null}

        {full ? (
          <div className="community-detail-card">
            <h2>О сообществе</h2>
            <p>{detail.description || 'Описание пока не добавлено.'}</p>
            <dl>
              <div>
                <dt>Участников</dt>
                <dd>{detail.memberCount}</dd>
              </div>
              <div>
                <dt>Вступление</dt>
                <dd>{joinActionLabel(joinAction)}</dd>
              </div>
            </dl>
          </div>
        ) : null}

        {membership ? (
          <div className="community-detail-card">
            <h2>Ваше участие</h2>
            <p>Роль: {membership.role}</p>
            {membership.memberRank ? <p>Место в рейтинге: {membership.memberRank}</p> : null}
          </div>
        ) : null}

        {canReadFeed ? (
          <CommunityFeed
            communityId={communityId}
            canPublish={canPublish}
            {...(canonicalFeedSnapshot ? { canonicalSnapshot: canonicalFeedSnapshot } : {})}
            loadFeed={loadFeed}
            issueMediaUpload={issueMediaUpload}
            finalizeMediaUpload={finalizeMediaUpload}
            getMediaStatus={getMediaStatus}
            createPost={createPost}
            loadMediaVariant={loadMediaVariant}
          />
        ) : null}

        {canManageInvites ? (
          <CommunityInviteManagement
            communityId={communityId}
            issuerMembershipRevision={membershipState.membershipRevision}
            loadInvites={loadInvites}
            createInvite={createInvite}
            revokeInvite={revokeInvite}
          />
        ) : null}
      </section>
    </main>
  );
}
