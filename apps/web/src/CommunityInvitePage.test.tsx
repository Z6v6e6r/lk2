// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CommunityInvitePage } from './CommunityInvitePage.js';
import type { CommunityDirectInvitePreview, CommunityOwnMembershipState } from './auth-gateway.js';

const token = 'a'.repeat(43);
const preview: CommunityDirectInvitePreview = {
  inviteId: '10000000-0000-4000-8000-000000000001',
  inviteRevision: 1,
  community: {
    id: '20000000-0000-4000-8000-000000000002',
    title: 'Падель друзья',
    logoUrl: null,
    isVerified: true,
    visibility: 'HIDDEN',
  },
  expiresAt: '2026-08-11T12:00:00.000Z',
  membershipRevision: 4,
  redeemAction: 'CONFIRM_MEMBERSHIP',
};

const membership: CommunityOwnMembershipState = {
  communityId: preview.community.id,
  membershipStatus: 'ACTIVE',
  role: 'MEMBER',
  membershipRevision: 5,
  joinRequest: null,
  joinAction: 'OPEN_COMMUNITY',
  updatedAt: '2026-08-04T12:00:00.000Z',
};

afterEach(cleanup);

describe('CommunityInvitePage', () => {
  it('previews without mutating and redeems only after the explicit button click', async () => {
    const previewInvite = vi.fn().mockResolvedValue(preview);
    const redeemInvite = vi.fn().mockResolvedValue(membership);

    render(
      <CommunityInvitePage
        token={token}
        previewInvite={previewInvite}
        redeemInvite={redeemInvite}
      />,
    );

    expect(await screen.findByRole('heading', { name: 'Падель друзья' })).toBeVisible();
    expect(previewInvite).toHaveBeenCalledWith(token);
    expect(redeemInvite).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Вступить в сообщество' }));

    await waitFor(() =>
      expect(redeemInvite).toHaveBeenCalledWith(token, preview.inviteRevision, 4),
    );
    expect(await screen.findByText('Готово, вы вступили в сообщество.')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Открыть сообщество' })).toHaveAttribute(
      'href',
      `/communities/${preview.community.id}`,
    );
  });

  it('does not expose a redeem action while an existing request is pending', async () => {
    render(
      <CommunityInvitePage
        token={token}
        previewInvite={vi.fn().mockResolvedValue({ ...preview, redeemAction: 'REQUEST_PENDING' })}
        redeemInvite={vi.fn()}
      />,
    );

    expect(await screen.findByText(/заявка уже рассматривается/i)).toBeVisible();
    expect(screen.queryByRole('button', { name: /вступить/i })).not.toBeInTheDocument();
  });

  it('fails closed when no fragment token was captured', () => {
    const previewInvite = vi.fn();
    render(
      <CommunityInvitePage token={null} previewInvite={previewInvite} redeemInvite={vi.fn()} />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('Ссылка приглашения неполная');
    expect(previewInvite).not.toHaveBeenCalled();
  });
});
