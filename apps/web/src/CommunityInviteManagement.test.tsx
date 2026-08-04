// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CommunityInviteManagement } from './CommunityInviteManagement.js';

const communityId = '11111111-1111-4111-8111-111111111111';
const inviteId = '22222222-2222-4222-8222-222222222222';
const token = 'x'.repeat(43);

afterEach(cleanup);

describe('CommunityInviteManagement', () => {
  it('shows a newly created raw link only in the current UI state', async () => {
    const user = userEvent.setup();
    const loadInvites = vi
      .fn()
      .mockResolvedValueOnce({ items: [] })
      .mockResolvedValueOnce({
        items: [
          {
            id: inviteId,
            communityId,
            status: 'ACTIVE',
            revision: 1,
            createdAt: '2026-08-04T12:00:00.000Z',
            expiresAt: '2026-08-11T12:00:00.000Z',
            updatedAt: '2026-08-04T12:00:00.000Z',
          },
        ],
      });
    const createInvite = vi.fn().mockResolvedValue({
      id: inviteId,
      communityId,
      status: 'ACTIVE',
      revision: 1,
      token,
      createdAt: '2026-08-04T12:00:00.000Z',
      expiresAt: '2026-08-11T12:00:00.000Z',
    });

    render(
      <CommunityInviteManagement
        communityId={communityId}
        issuerMembershipRevision={8}
        loadInvites={loadInvites}
        createInvite={createInvite}
        revokeInvite={vi.fn()}
      />,
    );

    expect(await screen.findByText('Активных ссылок пока нет.')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Создать ссылку' }));

    expect(createInvite).toHaveBeenCalledWith(communityId, 8);
    const field = await screen.findByLabelText('Новая ссылка показывается только сейчас');
    expect(field).toHaveValue(`http://localhost:3000/community-invite#${token}`);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Отозвать' })).toBeVisible());

    await user.click(screen.getByRole('button', { name: 'Скрыть' }));
    expect(screen.queryByDisplayValue(new RegExp(token))).not.toBeInTheDocument();
  });
});
