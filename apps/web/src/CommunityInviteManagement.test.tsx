// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CommunityInviteManagement } from './CommunityInviteManagement.js';

const communityId = '11111111-1111-4111-8111-111111111111';
const inviteId = '22222222-2222-4222-8222-222222222222';
const token = 'x'.repeat(43);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

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

  it('copies the one-time link and gives a manual fallback when clipboard access fails', async () => {
    const user = userEvent.setup();
    const writeText = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('permission denied'));
    Object.defineProperty(window.navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const loadInvites = vi.fn().mockResolvedValue({ items: [] });
    render(
      <CommunityInviteManagement
        communityId={communityId}
        issuerMembershipRevision={3}
        loadInvites={loadInvites}
        createInvite={vi.fn().mockResolvedValue({
          id: inviteId,
          communityId,
          status: 'ACTIVE',
          revision: 1,
          token,
          createdAt: '2026-08-04T12:00:00.000Z',
          expiresAt: '2026-08-11T12:00:00.000Z',
        })}
        revokeInvite={vi.fn()}
      />,
    );

    await user.click(await screen.findByRole('button', { name: 'Создать ссылку' }));
    const copy = await screen.findByRole('button', { name: 'Скопировать' });
    await user.click(copy);
    expect(writeText).toHaveBeenCalledWith(`http://localhost:3000/community-invite#${token}`);
    expect(await screen.findByText('Ссылка скопирована.')).toBeVisible();

    await user.click(copy);
    expect(await screen.findByText('Скопируйте ссылку из поля вручную.')).toBeVisible();
  });

  it('appends an opaque cursor page and revokes with the canonical invite revision', async () => {
    const secondInviteId = '33333333-3333-4333-8333-333333333333';
    const first = {
      id: inviteId,
      communityId,
      status: 'ACTIVE' as const,
      revision: 2,
      createdAt: '2026-08-04T12:00:00.000Z',
      expiresAt: '2026-08-11T12:00:00.000Z',
      updatedAt: '2026-08-04T12:00:00.000Z',
    };
    const second = { ...first, id: secondInviteId, revision: 7 };
    const loadInvites = vi
      .fn()
      .mockResolvedValueOnce({ items: [first], nextCursor: 'opaque-cursor' })
      .mockResolvedValueOnce({ items: [second] });
    const revokeInvite = vi.fn().mockResolvedValue({ ...second, status: 'REVOKED', revision: 8 });
    const user = userEvent.setup();
    render(
      <CommunityInviteManagement
        communityId={communityId}
        issuerMembershipRevision={4}
        loadInvites={loadInvites}
        createInvite={vi.fn()}
        revokeInvite={revokeInvite}
      />,
    );

    await user.click(await screen.findByRole('button', { name: 'Показать ещё' }));
    expect(loadInvites).toHaveBeenLastCalledWith(communityId, 'opaque-cursor');
    const revokeButtons = await screen.findAllByRole('button', { name: 'Отозвать' });
    expect(revokeButtons).toHaveLength(2);
    await user.click(revokeButtons[1]!);

    expect(revokeInvite).toHaveBeenCalledWith(secondInviteId, 7);
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: 'Отозвать' })).toHaveLength(1),
    );
  });

  it('keeps active links visible and reports create, revoke and pagination failures', async () => {
    const active = {
      id: inviteId,
      communityId,
      status: 'ACTIVE' as const,
      revision: 2,
      createdAt: '2026-08-04T12:00:00.000Z',
      expiresAt: '2026-08-11T12:00:00.000Z',
      updatedAt: '2026-08-04T12:00:00.000Z',
    };
    const loadInvites = vi
      .fn()
      .mockResolvedValueOnce({ items: [active], nextCursor: 'next' })
      .mockRejectedValueOnce(new Error('page offline'));
    const user = userEvent.setup();
    render(
      <CommunityInviteManagement
        communityId={communityId}
        issuerMembershipRevision={4}
        loadInvites={loadInvites}
        createInvite={vi.fn().mockRejectedValue(new Error('quota'))}
        revokeInvite={vi.fn().mockRejectedValue(new Error('conflict'))}
      />,
    );

    await user.click(await screen.findByRole('button', { name: 'Создать ссылку' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Не удалось создать ссылку');
    await user.click(screen.getByRole('button', { name: 'Отозвать' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Не удалось отозвать ссылку');
    expect(screen.getByRole('button', { name: 'Отозвать' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Показать ещё' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Не удалось загрузить следующую страницу',
    );
  });

  it('fails closed when the initial invite list cannot be loaded', async () => {
    render(
      <CommunityInviteManagement
        communityId={communityId}
        issuerMembershipRevision={1}
        loadInvites={vi.fn().mockRejectedValue(new Error('offline'))}
        createInvite={vi.fn()}
        revokeInvite={vi.fn()}
      />,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Не удалось загрузить активные ссылки',
    );
    expect(screen.queryByText('Загружаем ссылки…')).not.toBeInTheDocument();
  });
});
