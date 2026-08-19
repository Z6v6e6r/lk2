// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CommunityDetailPage } from './CommunityDetailPage.js';
import type {
  CommunityDetailView,
  CommunityFeedPage,
  CommunityOwnMembershipState,
} from './auth-gateway.js';
import type {
  CommunityRealtimeSubscriptionCallbacks,
  CommunityRealtimeTransport,
} from './community-realtime-transport.js';

const communityId = '11111111-1111-4111-8111-111111111111';

const detail: CommunityDetailView = {
  id: communityId,
  title: 'Padel Friends',
  logoUrl: null,
  isVerified: true,
  visibility: 'PUBLIC',
  joinAction: 'REQUEST_TO_JOIN',
  description: 'Открытое падел-сообщество',
  memberCount: 42,
  joinPolicy: 'MODERATED',
  createdAt: '2026-08-03T10:00:00.000Z',
};

function membershipState(
  overrides: Partial<CommunityOwnMembershipState> = {},
): CommunityOwnMembershipState {
  return {
    communityId,
    membershipStatus: 'NONE',
    role: null,
    membershipRevision: 0,
    joinRequest: null,
    joinAction: 'REQUEST_TO_JOIN',
    updatedAt: null,
    ...overrides,
  };
}

function renderPage(
  state: CommunityOwnMembershipState,
  overrides: Partial<React.ComponentProps<typeof CommunityDetailPage>> = {},
) {
  const props: React.ComponentProps<typeof CommunityDetailPage> = {
    communityId,
    loadDetail: vi.fn().mockResolvedValue(detail),
    loadMembershipState: vi.fn().mockResolvedValue(state),
    joinOrRequestMembership: vi.fn().mockRejectedValue(new Error('not configured')),
    cancelJoinRequest: vi.fn().mockRejectedValue(new Error('not configured')),
    leaveMembership: vi.fn().mockRejectedValue(new Error('not configured')),
    loadInvites: vi.fn().mockResolvedValue({ items: [] }),
    createInvite: vi.fn().mockRejectedValue(new Error('not configured')),
    revokeInvite: vi.fn().mockRejectedValue(new Error('not configured')),
    loadFeed: vi.fn().mockResolvedValue({
      items: [],
      watermark: '2026-08-03T10:00:00.000Z',
    }),
    issueMediaUpload: vi.fn().mockRejectedValue(new Error('not configured')),
    finalizeMediaUpload: vi.fn().mockRejectedValue(new Error('not configured')),
    getMediaStatus: vi.fn().mockRejectedValue(new Error('not configured')),
    createPost: vi.fn().mockRejectedValue(new Error('not configured')),
    loadMediaVariant: vi.fn().mockRejectedValue(new Error('not configured')),
    recoverCommunityEvents: vi.fn().mockResolvedValue({
      items: [],
      afterSequence: 0,
      latestSequence: 0,
      retainedFromSequence: 1,
      hasMore: false,
    }),
    ...overrides,
  };

  return render(<CommunityDetailPage {...props} />);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('CommunityDetailPage membership lifecycle', () => {
  it('mounts invite management only for an enabled active owner runtime', async () => {
    const loadInvites = vi.fn().mockResolvedValue({ items: [] });
    const owner = membershipState({
      membershipStatus: 'ACTIVE',
      role: 'OWNER',
      membershipRevision: 2,
      joinAction: 'OPEN_COMMUNITY',
    });
    const first = renderPage(owner, { loadInvites });

    await screen.findByText('Сначала передайте права владельца другому участнику.');
    expect(loadInvites).not.toHaveBeenCalled();
    first.unmount();

    renderPage(owner, { communityDirectInvitesEnabled: true, loadInvites });

    await waitFor(() => expect(loadInvites).toHaveBeenCalledWith(communityId));
  });

  it.each([
    ['JOIN_NOW', 'Вступить'],
    ['REQUEST_TO_JOIN', 'Подать заявку'],
    ['REQUEST_REJOIN', 'Запросить повторное вступление'],
  ] as const)('sends only the current membership revision for %s', async (joinAction, label) => {
    const nextState = membershipState({
      membershipStatus: 'ACTIVE',
      role: 'MEMBER',
      membershipRevision: 8,
      joinAction: 'OPEN_COMMUNITY',
      updatedAt: '2026-08-03T11:00:00.000Z',
    });
    const joinOrRequestMembership = vi.fn().mockResolvedValue(nextState);
    renderPage(
      membershipState({
        membershipStatus: joinAction === 'REQUEST_REJOIN' ? 'REMOVED' : 'NONE',
        membershipRevision: 7,
        joinAction,
      }),
      { joinOrRequestMembership },
    );
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: label }));

    expect(joinOrRequestMembership).toHaveBeenCalledWith(communityId, 7);
    expect(await screen.findByRole('button', { name: 'Покинуть сообщество' })).toBeEnabled();
  });

  it('cancels a pending request with both canonical revisions', async () => {
    const cancelJoinRequest = vi.fn().mockResolvedValue(
      membershipState({
        membershipStatus: 'NONE',
        membershipRevision: 4,
        joinAction: 'REQUEST_TO_JOIN',
      }),
    );
    renderPage(
      membershipState({
        membershipStatus: 'PENDING',
        membershipRevision: 3,
        joinAction: 'MEMBERSHIP_PENDING',
        joinRequest: {
          id: '22222222-2222-4222-8222-222222222222',
          communityId,
          kind: 'JOIN',
          status: 'PENDING',
          revision: 6,
          createdAt: '2026-08-03T10:00:00.000Z',
          updatedAt: '2026-08-03T10:00:00.000Z',
        },
      }),
      { cancelJoinRequest },
    );
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Отменить заявку' }));

    expect(cancelJoinRequest).toHaveBeenCalledWith(
      communityId,
      '22222222-2222-4222-8222-222222222222',
      3,
      6,
    );
    expect(await screen.findByRole('button', { name: 'Подать заявку' })).toBeEnabled();
  });

  it('requires confirmation before leaving and uses the current membership revision', async () => {
    const leaveMembership = vi.fn().mockResolvedValue(
      membershipState({
        membershipStatus: 'LEFT',
        membershipRevision: 13,
        joinAction: 'REQUEST_REJOIN',
      }),
    );
    renderPage(
      membershipState({
        membershipStatus: 'ACTIVE',
        role: 'MEMBER',
        membershipRevision: 12,
        joinAction: 'OPEN_COMMUNITY',
      }),
      { leaveMembership },
    );
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Покинуть сообщество' }));
    expect(leaveMembership).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Подтвердить выход' }));

    expect(leaveMembership).toHaveBeenCalledWith(communityId, 12);
    expect(
      await screen.findByRole('button', { name: 'Запросить повторное вступление' }),
    ).toBeEnabled();
  });

  it('does not offer exit to the owner', async () => {
    const leaveMembership = vi.fn();
    renderPage(
      membershipState({
        membershipStatus: 'ACTIVE',
        role: 'OWNER',
        membershipRevision: 2,
        joinAction: 'OPEN_COMMUNITY',
      }),
      { leaveMembership },
    );

    expect(
      await screen.findByText('Сначала передайте права владельца другому участнику.'),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Покинуть сообщество' })).not.toBeInTheDocument();
    expect(leaveMembership).not.toHaveBeenCalled();
  });

  it.each([
    [
      membershipState({ joinAction: 'INVITE_REQUIRED' }),
      'Вступить можно только по приглашению владельца или администратора.',
    ],
    [
      membershipState({ membershipStatus: 'BANNED', joinAction: 'UNAVAILABLE' }),
      'Доступ к вступлению в это сообщество ограничен.',
    ],
  ])('renders a non-actionable restricted state', async (state, message) => {
    const joinOrRequestMembership = vi.fn();
    renderPage(state, { joinOrRequestMembership });

    expect(await screen.findByText(message)).toBeVisible();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(joinOrRequestMembership).not.toHaveBeenCalled();
  });

  it('fails closed when own membership state cannot be loaded', async () => {
    renderPage(membershipState(), {
      loadMembershipState: vi.fn().mockRejectedValue(new Error('network')),
    });

    expect(
      await screen.findByText('Не удалось проверить состояние участия. Обновите страницу.'),
    ).toHaveAttribute('role', 'alert');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('keeps the command available after a failed mutation', async () => {
    renderPage(membershipState(), {
      joinOrRequestMembership: vi.fn().mockRejectedValue(new Error('revision conflict')),
    });
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Подать заявку' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Не удалось выполнить действие. Состояние не изменено — попробуйте ещё раз.',
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Подать заявку' })).toBeEnabled(),
    );
  });
});

describe('CommunityDetailPage content access', () => {
  it('shows the public feed without exposing the composer to a non-member', async () => {
    const loadFeed = vi.fn().mockResolvedValue({
      items: [],
      watermark: '2026-08-03T10:00:00.000Z',
    });
    renderPage(membershipState(), { loadFeed });

    expect(await screen.findByRole('region', { name: 'Лента сообщества' })).toBeVisible();
    await waitFor(() => expect(loadFeed).toHaveBeenCalledWith(communityId));
    expect(screen.queryByLabelText('Новая публикация')).not.toBeInTheDocument();
  });

  it('does not request a LISTED_PRIVATE feed before active membership', async () => {
    const loadFeed = vi.fn();
    renderPage(membershipState({ joinAction: 'REQUEST_TO_JOIN' }), {
      loadDetail: vi.fn().mockResolvedValue({
        id: communityId,
        title: 'Private club',
        logoUrl: null,
        isVerified: false,
        visibility: 'LISTED_PRIVATE',
        joinAction: 'REQUEST_TO_JOIN',
      } satisfies CommunityDetailView),
      loadFeed,
    });

    expect(await screen.findByRole('heading', { name: 'Private club' })).toBeVisible();
    expect(screen.queryByRole('region', { name: 'Лента сообщества' })).not.toBeInTheDocument();
    expect(loadFeed).not.toHaveBeenCalled();
  });

  it.each([
    ['STAFF_FEED', false],
    ['MODERATED_FEED', true],
  ] as const)(
    'applies %s composer visibility for an active MEMBER',
    async (publishingPreset, visible) => {
      renderPage(
        membershipState({
          membershipStatus: 'ACTIVE',
          role: 'MEMBER',
          membershipRevision: 4,
          joinAction: 'OPEN_COMMUNITY',
        }),
        {
          loadDetail: vi.fn().mockResolvedValue({
            ...detail,
            publishingPreset,
            revision: 4,
            updatedAt: '2026-08-03T10:00:00.000Z',
            viewerMembership: {
              status: 'ACTIVE',
              role: 'MEMBER',
              revision: 4,
            },
          } satisfies CommunityDetailView),
        },
      );

      expect(await screen.findByRole('region', { name: 'Лента сообщества' })).toBeVisible();
      if (visible) {
        expect(screen.getByLabelText('Новая публикация')).toBeVisible();
      } else {
        expect(screen.queryByLabelText('Новая публикация')).not.toBeInTheDocument();
      }
    },
  );
});

describe('CommunityDetailPage realtime recovery', () => {
  it('seeds from a canonical snapshot before recovering a buffered hint', async () => {
    let callbacks: CommunityRealtimeSubscriptionCallbacks | undefined;
    const unsubscribe = vi.fn();
    const subscribe = vi.fn(
      (_communityId: string, nextCallbacks: CommunityRealtimeSubscriptionCallbacks) => {
        callbacks = nextCallbacks;
        return unsubscribe;
      },
    );
    const realtimeTransport: CommunityRealtimeTransport = {
      start: vi.fn(),
      stop: vi.fn(),
      clear: vi.fn(),
      isStarted: () => true,
      subscribe,
    };
    const canonicalPage: CommunityFeedPage = {
      items: [],
      watermark: '2026-08-03T10:00:00.000Z',
    };
    let releaseSeed: (() => void) | undefined;
    const seedGate = new Promise<void>((resolve) => {
      releaseSeed = resolve;
    });
    const loadFeed = vi
      .fn()
      .mockResolvedValueOnce(canonicalPage)
      .mockImplementationOnce(async () => {
        await seedGate;
        return canonicalPage;
      })
      .mockResolvedValue(canonicalPage);
    const recoverCommunityEvents = vi.fn().mockResolvedValue({
      items: [
        {
          communityId,
          sequence: 13,
          eventId: '33333333-3333-4333-8333-333333333333',
          eventType: 'COMMUNITY_POST_PUBLISHED',
          targetType: 'POST',
          targetId: '44444444-4444-4444-8444-444444444444',
          targetRevision: 1,
          targetStatus: 'PUBLISHED',
          occurredAt: '2026-08-03T10:01:00.000Z',
        },
      ],
      afterSequence: 12,
      latestSequence: 13,
      retainedFromSequence: 1,
      hasMore: false,
    });

    const { unmount } = renderPage(
      membershipState({
        membershipStatus: 'ACTIVE',
        role: 'MEMBER',
        membershipRevision: 4,
        joinAction: 'OPEN_COMMUNITY',
      }),
      {
        loadDetail: vi.fn().mockResolvedValue({
          ...detail,
          publishingPreset: 'MODERATED_FEED',
          revision: 4,
          updatedAt: '2026-08-03T10:00:00.000Z',
          viewerMembership: { status: 'ACTIVE', role: 'MEMBER', revision: 4 },
        } satisfies CommunityDetailView),
        loadFeed,
        recoverCommunityEvents,
        realtimeTransport,
      },
    );

    await waitFor(() => expect(subscribe).toHaveBeenCalledOnce());
    let subscribed: Promise<void> | void;
    let hinted: Promise<void> | void;
    await act(async () => {
      subscribed = callbacks?.onSubscribed({
        communityId,
        communityRevision: 4,
        membershipRevision: 4,
        latestSequence: 12,
      });
      hinted = callbacks?.onHint({ communityId, sequence: 13 });
      await Promise.resolve();
    });
    expect(recoverCommunityEvents).not.toHaveBeenCalled();

    await act(async () => {
      releaseSeed?.();
      await subscribed;
      await hinted;
    });

    expect(recoverCommunityEvents).toHaveBeenCalledWith(communityId, {
      afterSequence: 12,
      limit: 100,
    });
    expect(loadFeed).toHaveBeenCalledTimes(3);
    unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
