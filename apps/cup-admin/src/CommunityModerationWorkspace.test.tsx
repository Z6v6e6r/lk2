// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CommunityModerationWorkspace } from './CommunityModerationWorkspace.js';
import type { NotificationAdminClient } from './notification-admin-client.js';

afterEach(cleanup);

const request = {
  requestId: '22222222-2222-4222-8222-222222222222',
  communityId: '11111111-1111-4111-8111-111111111111',
  requesterUserId: '33333333-3333-4333-8333-333333333333',
  kind: 'REJOIN' as const,
  status: 'PENDING' as const,
  membershipStatus: 'PENDING' as const,
  membershipRevision: 3,
  requestRevision: 1,
  requestedAt: '2026-08-03T10:00:00.000Z',
};

describe('CommunityModerationWorkspace', () => {
  it('loads the canonical queue and approves with server revisions only', async () => {
    const approveCommunityJoinRequest = vi.fn().mockResolvedValue({ outcome: 'APPROVED' });
    const client = {
      listPendingCommunityJoinRequests: vi.fn().mockResolvedValue({ items: [request] }),
      listPendingCommunityContent: vi.fn().mockResolvedValue({ items: [] }),
      approveCommunityJoinRequest,
      rejectCommunityJoinRequest: vi.fn(),
    } as unknown as NotificationAdminClient;

    render(<CommunityModerationWorkspace client={client} />);

    expect(await screen.findByText('Повторный вход')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Одобрить' }));

    await waitFor(() =>
      expect(approveCommunityJoinRequest).toHaveBeenCalledWith(request.requestId, {
        expectedMembershipRevision: 3,
        expectedRequestRevision: 1,
      }),
    );
    expect(screen.queryByText('Повторный вход')).not.toBeInTheDocument();
  });

  it('requires a structured reason code before rejection', async () => {
    const rejectCommunityJoinRequest = vi.fn();
    const client = {
      listPendingCommunityJoinRequests: vi.fn().mockResolvedValue({ items: [request] }),
      listPendingCommunityContent: vi.fn().mockResolvedValue({ items: [] }),
      approveCommunityJoinRequest: vi.fn(),
      rejectCommunityJoinRequest,
    } as unknown as NotificationAdminClient;

    render(<CommunityModerationWorkspace client={client} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Отклонить' }));
    expect(
      await screen.findByText(/Для отклонения укажите код причины латиницей/),
    ).toBeInTheDocument();
    expect(rejectCommunityJoinRequest).not.toHaveBeenCalled();
  });

  it('requires audit evidence and creates a quota grant without an issuer selector', async () => {
    const createCommunityDirectInviteQuotaGrant = vi.fn().mockResolvedValue({
      status: 'ACTIVE',
      expiresAt: '2026-08-05T12:00:00.000Z',
    });
    const client = {
      listPendingCommunityJoinRequests: vi.fn().mockResolvedValue({ items: [] }),
      listPendingCommunityContent: vi.fn().mockResolvedValue({ items: [] }),
      createCommunityDirectInviteQuotaGrant,
    } as unknown as NotificationAdminClient;

    render(<CommunityModerationWorkspace client={client} />);

    fireEvent.change(screen.getByLabelText('Community UUID'), {
      target: { value: request.communityId },
    });
    fireEvent.change(screen.getByLabelText('Код причины'), {
      target: { value: 'operations_exception' },
    });
    const createButton = screen.getByRole('button', { name: 'Создать quota grant' });
    await waitFor(() => expect(createButton).toBeEnabled());
    fireEvent.click(createButton);
    expect(
      await screen.findByText(/Для исключения нужны Community UUID, код причины и ticket ID/),
    ).toBeInTheDocument();
    expect(createCommunityDirectInviteQuotaGrant).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Ticket ID'), { target: { value: 'CUP-1842' } });
    fireEvent.click(createButton);
    await waitFor(() =>
      expect(createCommunityDirectInviteQuotaGrant).toHaveBeenCalledWith(request.communityId, {
        reasonCode: 'OPERATIONS_EXCEPTION',
        ticketId: 'CUP-1842',
      }),
    );
    expect(await screen.findByText('Статус: ACTIVE')).toBeInTheDocument();
    expect(screen.queryByText(/токен/i)).not.toBeInTheDocument();
  });

  it('creates a user-scoped one-use grant with explicit scopes and audit evidence', async () => {
    const createCommunityCreateQuotaGrant = vi.fn().mockResolvedValue({
      status: 'ACTIVE',
      scopes: ['ACTIVE_OWNER_LIMIT'],
      expiresAt: '2026-08-05T12:00:00.000Z',
    });
    const client = {
      listPendingCommunityJoinRequests: vi.fn().mockResolvedValue({ items: [] }),
      listPendingCommunityContent: vi.fn().mockResolvedValue({ items: [] }),
      createCommunityCreateQuotaGrant,
    } as unknown as NotificationAdminClient;

    render(<CommunityModerationWorkspace client={client} />);
    fireEvent.change(screen.getByLabelText('User UUID'), {
      target: { value: request.requesterUserId },
    });
    const ownerScope = screen.getByLabelText('Лимит активного владения');
    fireEvent.click(ownerScope);
    await waitFor(() => expect(ownerScope).toBeChecked());
    fireEvent.change(screen.getByLabelText('Код причины создания'), {
      target: { value: 'operations_exception' },
    });
    fireEvent.change(screen.getByLabelText('Ticket ID создания'), {
      target: { value: 'CUP-1842' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Создать grant создания' }));

    await waitFor(() =>
      expect(createCommunityCreateQuotaGrant).toHaveBeenCalledWith(request.requesterUserId, {
        scopes: ['ACTIVE_OWNER_LIMIT'],
        reasonCode: 'OPERATIONS_EXCEPTION',
        ticketId: 'CUP-1842',
      }),
    );
    expect(await screen.findByText('Grant создания создан.')).toBeInTheDocument();
  });

  it('loads and approves pending content with only the canonical revision', async () => {
    const post = {
      id: '44444444-4444-4444-8444-444444444444',
      communityId: request.communityId,
      authorUserId: request.requesterUserId,
      status: 'PENDING_MODERATION' as const,
      body: 'Публикация для проверки',
      revision: 3,
      createdAt: '2026-08-04T12:00:00.000Z',
      publishedAt: null,
      updatedAt: '2026-08-04T12:05:00.000Z',
      archivedAt: null,
      restoreUntil: null,
      retentionUntil: null,
    };
    const approveCommunityPost = vi.fn().mockResolvedValue({ ...post, status: 'PUBLISHED' });
    const client = {
      listPendingCommunityJoinRequests: vi.fn().mockResolvedValue({ items: [] }),
      listPendingCommunityContent: vi.fn().mockResolvedValue({ items: [{ post }] }),
      approveCommunityPost,
    } as unknown as NotificationAdminClient;

    render(<CommunityModerationWorkspace client={client} />);
    expect(await screen.findByText('Публикация для проверки')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Одобрить публикацию' }));
    await waitFor(() =>
      expect(approveCommunityPost).toHaveBeenCalledWith(post.communityId, post.id, 3),
    );
    expect(screen.queryByText('Публикация для проверки')).not.toBeInTheDocument();
  });

  it('loads each moderation image through the capability-checked preview grant', async () => {
    const mediaId = '77777777-7777-4777-8777-777777777777';
    const post = {
      id: '44444444-4444-4444-8444-444444444444',
      communityId: request.communityId,
      authorUserId: request.requesterUserId,
      status: 'PENDING_MODERATION' as const,
      body: 'Публикация с изображением',
      revision: 3,
      createdAt: '2026-08-04T12:00:00.000Z',
      publishedAt: null,
      updatedAt: '2026-08-04T12:05:00.000Z',
      archivedAt: null,
      restoreUntil: null,
      retentionUntil: null,
      media: [
        {
          id: mediaId,
          mediaType: 'IMAGE' as const,
          width: 640,
          height: 480,
          variants: [
            {
              variant: 'THUMBNAIL' as const,
              url: '/user/api/v1/local-padel/communities/example/media/example/THUMBNAIL',
              contentType: 'image/webp' as const,
              width: 640,
              height: 480,
              byteSize: 1024,
            },
          ],
        },
      ],
    };
    const getCommunityModerationMediaUrl = vi.fn().mockResolvedValue({
      url: 'https://media.test/signed-thumbnail',
      expiresAt: '2026-08-04T12:10:00.000Z',
    });
    const client = {
      listPendingCommunityJoinRequests: vi.fn().mockResolvedValue({ items: [] }),
      listPendingCommunityContent: vi.fn().mockResolvedValue({ items: [{ post }] }),
      getCommunityModerationMediaUrl,
    } as unknown as NotificationAdminClient;

    render(<CommunityModerationWorkspace client={client} />);
    const image = await screen.findByRole('img', { name: 'Изображение публикации' });
    expect(image).toHaveAttribute('src', 'https://media.test/signed-thumbnail');
    expect(getCommunityModerationMediaUrl).toHaveBeenCalledWith(
      request.communityId,
      mediaId,
      'THUMBNAIL',
    );
  });

  it('requires a reason and rejects pending content into the author-edit flow', async () => {
    const post = {
      id: '44444444-4444-4444-8444-444444444444',
      communityId: request.communityId,
      authorUserId: request.requesterUserId,
      status: 'PENDING_MODERATION' as const,
      body: 'Публикация для отклонения',
      revision: 3,
      createdAt: '2026-08-04T12:00:00.000Z',
      publishedAt: null,
      updatedAt: '2026-08-04T12:05:00.000Z',
      archivedAt: null,
      restoreUntil: null,
      retentionUntil: null,
    };
    const rejectCommunityPost = vi.fn().mockResolvedValue({ ...post, status: 'HIDDEN' });
    const client = {
      listPendingCommunityJoinRequests: vi.fn().mockResolvedValue({ items: [] }),
      listPendingCommunityContent: vi.fn().mockResolvedValue({ items: [{ post }] }),
      rejectCommunityPost,
    } as unknown as NotificationAdminClient;

    render(<CommunityModerationWorkspace client={client} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Отклонить публикацию' }));
    expect(await screen.findByText(/Для отклонения публикации укажите код причины/)).toBeVisible();
    expect(rejectCommunityPost).not.toHaveBeenCalled();

    fireEvent.change(screen.getAllByLabelText('Код причины отклонения')[0]!, {
      target: { value: 'content_policy_violation' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Отклонить публикацию' }));
    await waitFor(() =>
      expect(rejectCommunityPost).toHaveBeenCalledWith(post.communityId, post.id, {
        expectedRevision: 3,
        reasonCode: 'CONTENT_POLICY_VIOLATION',
      }),
    );
    expect(screen.queryByText('Публикация для отклонения')).not.toBeInTheDocument();
  });

  it('rejects a join request with sanitized reason and canonical revisions', async () => {
    const rejectCommunityJoinRequest = vi.fn().mockResolvedValue({ outcome: 'REJECTED' });
    const client = {
      listPendingCommunityJoinRequests: vi.fn().mockResolvedValue({ items: [request] }),
      listPendingCommunityContent: vi.fn().mockResolvedValue({ items: [] }),
      approveCommunityJoinRequest: vi.fn(),
      rejectCommunityJoinRequest,
    } as unknown as NotificationAdminClient;
    render(<CommunityModerationWorkspace client={client} />);

    fireEvent.change(await screen.findByLabelText('Код причины отклонения'), {
      target: { value: 'profile_incomplete!' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Отклонить' }));

    await waitFor(() =>
      expect(rejectCommunityJoinRequest).toHaveBeenCalledWith(request.requestId, {
        expectedMembershipRevision: 3,
        expectedRequestRevision: 1,
        reasonCode: 'PROFILE_INCOMPLETE',
      }),
    );
    expect(screen.queryByText('Повторный вход')).not.toBeInTheDocument();
  });

  it('loads cursor pages independently for membership and content queues', async () => {
    const nextRequest = { ...request, requestId: '55555555-5555-4555-8555-555555555555' };
    const post = {
      id: '44444444-4444-4444-8444-444444444444',
      communityId: request.communityId,
      authorUserId: request.requesterUserId,
      status: 'PENDING_MODERATION' as const,
      body: 'Первая публикация',
      revision: 3,
      createdAt: '2026-08-04T12:00:00.000Z',
      publishedAt: null,
      updatedAt: '2026-08-04T12:05:00.000Z',
      archivedAt: null,
      restoreUntil: null,
      retentionUntil: null,
    };
    const nextPost = {
      ...post,
      id: '66666666-6666-4666-8666-666666666666',
      body: 'Вторая публикация',
    };
    const listPendingCommunityJoinRequests = vi
      .fn()
      .mockResolvedValueOnce({ items: [request], nextCursor: 'join-next' })
      .mockResolvedValueOnce({ items: [nextRequest] });
    const listPendingCommunityContent = vi
      .fn()
      .mockResolvedValueOnce({ items: [{ post }], nextCursor: 'content-next' })
      .mockResolvedValueOnce({ items: [{ post: nextPost }] });
    const client = {
      listPendingCommunityJoinRequests,
      listPendingCommunityContent,
    } as unknown as NotificationAdminClient;
    render(<CommunityModerationWorkspace client={client} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Показать ещё публикации' }));
    await waitFor(() =>
      expect(listPendingCommunityContent).toHaveBeenLastCalledWith({
        cursor: 'content-next',
        limit: 20,
      }),
    );
    expect(await screen.findByText('Вторая публикация')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Показать ещё' }));
    await waitFor(() =>
      expect(listPendingCommunityJoinRequests).toHaveBeenLastCalledWith({
        cursor: 'join-next',
        limit: 20,
      }),
    );
    expect(screen.getAllByText('Повторный вход')).toHaveLength(2);
  });

  it('reports unavailable moderation media without exposing a broken image', async () => {
    const mediaId = '77777777-7777-4777-8777-777777777777';
    const post = {
      id: '44444444-4444-4444-8444-444444444444',
      communityId: request.communityId,
      authorUserId: request.requesterUserId,
      status: 'PENDING_MODERATION' as const,
      body: 'Публикация с недоступным изображением',
      revision: 3,
      createdAt: '2026-08-04T12:00:00.000Z',
      publishedAt: null,
      updatedAt: '2026-08-04T12:05:00.000Z',
      archivedAt: null,
      restoreUntil: null,
      retentionUntil: null,
      media: [
        {
          id: mediaId,
          mediaType: 'IMAGE' as const,
          width: 640,
          height: 480,
          variants: [],
        },
      ],
    };
    const client = {
      listPendingCommunityJoinRequests: vi.fn().mockResolvedValue({ items: [] }),
      listPendingCommunityContent: vi.fn().mockResolvedValue({ items: [{ post }] }),
      getCommunityModerationMediaUrl: vi.fn().mockRejectedValue(new Error('expired grant')),
    } as unknown as NotificationAdminClient;
    render(<CommunityModerationWorkspace client={client} />);

    expect(await screen.findByText('Превью недоступно')).toBeVisible();
    expect(screen.queryByRole('img', { name: 'Изображение публикации' })).not.toBeInTheDocument();
  });

  it('keeps canonical queue items after failed decisions and surfaces the client error', async () => {
    const client = {
      listPendingCommunityJoinRequests: vi.fn().mockResolvedValue({ items: [request] }),
      listPendingCommunityContent: vi.fn().mockResolvedValue({ items: [] }),
      approveCommunityJoinRequest: vi.fn().mockRejectedValue(new Error('Revision conflict')),
      rejectCommunityJoinRequest: vi.fn(),
      createCommunityDirectInviteQuotaGrant: vi.fn().mockRejectedValue(new Error('Grant denied')),
    } as unknown as NotificationAdminClient;
    render(<CommunityModerationWorkspace client={client} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Одобрить' }));
    expect(await screen.findByText('Revision conflict')).toBeVisible();
    expect(screen.getByText('Повторный вход')).toBeVisible();

    fireEvent.change(screen.getByLabelText('Community UUID'), {
      target: { value: request.communityId },
    });
    fireEvent.change(screen.getByLabelText('Код причины'), {
      target: { value: 'OPERATIONS_EXCEPTION' },
    });
    fireEvent.change(screen.getByLabelText('Ticket ID'), { target: { value: 'CUP-1842' } });
    fireEvent.click(screen.getByRole('button', { name: 'Создать quota grant' }));
    expect(await screen.findByText('Grant denied')).toBeVisible();
  });
});
