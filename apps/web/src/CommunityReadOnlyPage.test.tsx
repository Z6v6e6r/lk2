// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CommunityReadOnlyPage } from './CommunityReadOnlyPage.js';

afterEach(cleanup);

describe('CommunityReadOnlyPage', () => {
  it('resets section state when navigation selects another community', async () => {
    let resolveSecondDetail!: (value: {
      id: string;
      title: string;
      logoUrl: null;
      isVerified: boolean;
      description: null;
      memberCount: number;
      readOnly: true;
    }) => void;
    const loadDetail = vi
      .fn()
      .mockResolvedValueOnce({
        id: '11111111-1111-4111-8111-111111111111',
        title: 'Первое сообщество',
        logoUrl: null,
        isVerified: false,
        description: null,
        memberCount: 5,
        readOnly: true,
      })
      .mockImplementationOnce(
        () =>
          new Promise<Parameters<typeof resolveSecondDetail>[0]>((resolve) => {
            resolveSecondDetail = resolve;
          }),
      );
    const loadFeed = vi.fn().mockResolvedValue({ items: [] });
    const view = render(
      <CommunityReadOnlyPage
        communityId="11111111-1111-4111-8111-111111111111"
        feedEnabled
        chatEnabled={false}
        ratingEnabled={false}
        loadDetail={loadDetail}
        loadFeed={loadFeed}
        loadChat={vi.fn()}
        loadRating={vi.fn()}
      />,
    );

    expect(await screen.findByText('Первое сообщество')).toBeInTheDocument();
    view.rerender(
      <CommunityReadOnlyPage
        communityId="22222222-2222-4222-8222-222222222222"
        feedEnabled
        chatEnabled={false}
        ratingEnabled={false}
        loadDetail={loadDetail}
        loadFeed={loadFeed}
        loadChat={vi.fn()}
        loadRating={vi.fn()}
      />,
    );

    expect(screen.queryByText('Первое сообщество')).not.toBeInTheDocument();
    expect(screen.getByText('Загружаем сообщество…')).toBeInTheDocument();
    await act(async () => {
      resolveSecondDetail({
        id: '22222222-2222-4222-8222-222222222222',
        title: 'Второе сообщество',
        logoUrl: null,
        isVerified: false,
        description: null,
        memberCount: 3,
        readOnly: true,
      });
      await Promise.resolve();
    });
    expect(screen.getByText('Второе сообщество')).toBeInTheDocument();
  });

  it('renders the LK-style read-only feed and loads chat/rating only after tab selection', async () => {
    const loadChat = vi.fn().mockResolvedValue({
      items: [
        {
          body: 'Всем привет',
          sentAt: '2026-08-11T10:00:00.000Z',
          author: { displayName: 'Анна' },
          isViewer: true,
        },
      ],
    });
    const loadRating = vi.fn().mockResolvedValue({
      period: 'all',
      tab: 'overall',
      calculationVersion: 'community-rating-v1.3.0',
      rows: [
        {
          place: 1,
          displayName: 'Анна',
          currentLevel: 4.5,
          score: 120,
          delta: 2,
          games: 10,
          tournaments: 2,
        },
      ],
    });
    render(
      <CommunityReadOnlyPage
        communityId="11111111-1111-4111-8111-111111111111"
        feedEnabled
        chatEnabled
        ratingEnabled
        loadDetail={vi.fn().mockResolvedValue({
          id: '11111111-1111-4111-8111-111111111111',
          title: 'Падел на районе',
          logoUrl: null,
          isVerified: true,
          description: null,
          memberCount: 42,
          readOnly: true,
        })}
        loadFeed={vi.fn().mockResolvedValue({
          items: [
            {
              kind: 'PHOTO',
              title: 'Тренировка',
              body: 'Играем вечером',
              publishedAt: '2026-08-11T09:00:00.000Z',
              author: { displayName: 'Организатор' },
            },
          ],
        })}
        loadChat={loadChat}
        loadRating={loadRating}
      />,
    );

    expect(await screen.findByText('Падел на районе')).toBeInTheDocument();
    expect(screen.getByLabelText('Сообщество доступно только для просмотра')).toBeInTheDocument();
    expect(screen.getByText('Играем вечером')).toBeInTheDocument();
    expect(loadChat).not.toHaveBeenCalled();
    expect(loadRating).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('tab', { name: 'Чат' }));
    expect(await screen.findByText('Всем привет')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /сообщение/i })).toBeDisabled();

    fireEvent.click(screen.getByRole('tab', { name: 'Рейтинг' }));
    await waitFor(() => expect(loadRating).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('★ 120')).toBeInTheDocument();
  });

  it('opens the first enabled section and continues feed with its opaque cursor', async () => {
    const cursor = 'opaque-feed-cursor-long-enough';
    const loadFeed = vi
      .fn()
      .mockResolvedValueOnce({ items: [], nextCursor: cursor })
      .mockResolvedValueOnce({
        items: [
          {
            kind: 'SYSTEM',
            title: null,
            body: 'Продолжение ленты',
            publishedAt: '2026-08-11T09:00:00.000Z',
            author: { displayName: 'Система' },
          },
        ],
      });
    const detail = vi.fn().mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
      title: 'Сообщество',
      logoUrl: null,
      isVerified: false,
      description: null,
      memberCount: 5,
      readOnly: true,
    });
    const view = render(
      <CommunityReadOnlyPage
        communityId="11111111-1111-4111-8111-111111111111"
        feedEnabled
        chatEnabled={false}
        ratingEnabled={false}
        loadDetail={detail}
        loadFeed={loadFeed}
        loadChat={vi.fn()}
        loadRating={vi.fn()}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Показать ещё' }));
    expect(await screen.findByText('Продолжение ленты')).toBeInTheDocument();
    expect(loadFeed).toHaveBeenLastCalledWith('11111111-1111-4111-8111-111111111111', cursor);
    view.unmount();

    const loadChat = vi.fn().mockResolvedValue({ items: [] });
    render(
      <CommunityReadOnlyPage
        communityId="11111111-1111-4111-8111-111111111111"
        feedEnabled={false}
        chatEnabled
        ratingEnabled={false}
        loadDetail={detail}
        loadFeed={vi.fn()}
        loadChat={loadChat}
        loadRating={vi.fn()}
      />,
    );
    expect(await screen.findByRole('tab', { name: 'Чат' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(loadChat).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('tab', { name: 'Лента' })).not.toBeInTheDocument();
  });

  it('keeps the loaded feed visible and retries a failed cursor page', async () => {
    const cursor = 'opaque-feed-cursor-long-enough';
    const loadFeed = vi
      .fn()
      .mockResolvedValueOnce({
        items: [
          {
            kind: 'SYSTEM',
            title: null,
            body: 'Первая страница',
            publishedAt: '2026-08-11T09:00:00.000Z',
            author: { displayName: 'Система' },
          },
        ],
        nextCursor: cursor,
      })
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValueOnce({
        items: [
          {
            kind: 'SYSTEM',
            title: null,
            body: 'Страница после повтора',
            publishedAt: '2026-08-11T10:00:00.000Z',
            author: { displayName: 'Система' },
          },
        ],
      });
    render(
      <CommunityReadOnlyPage
        communityId="11111111-1111-4111-8111-111111111111"
        feedEnabled
        chatEnabled={false}
        ratingEnabled={false}
        loadDetail={vi.fn().mockResolvedValue({
          id: '11111111-1111-4111-8111-111111111111',
          title: 'Сообщество',
          logoUrl: null,
          isVerified: false,
          description: null,
          memberCount: 5,
          readOnly: true,
        })}
        loadFeed={loadFeed}
        loadChat={vi.fn()}
        loadRating={vi.fn()}
      />,
    );

    expect(await screen.findByText('Первая страница')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Показать ещё' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Не удалось догрузить ленту');
    expect(screen.getByText('Первая страница')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    expect(await screen.findByText('Страница после повтора')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(loadFeed).toHaveBeenNthCalledWith(3, '11111111-1111-4111-8111-111111111111', cursor);
  });

  it('loads a newly selected tab while the initial feed is still pending', async () => {
    let resolveFeed!: (value: { items: [] }) => void;
    const loadFeed = vi.fn(() => new Promise<{ items: [] }>((resolve) => (resolveFeed = resolve)));
    const loadChat = vi.fn().mockResolvedValue({
      items: [
        {
          body: 'Чат загрузился',
          sentAt: '2026-08-11T10:00:00.000Z',
          author: { displayName: 'Анна' },
          isViewer: false,
        },
      ],
    });
    render(
      <CommunityReadOnlyPage
        communityId="11111111-1111-4111-8111-111111111111"
        feedEnabled
        chatEnabled
        ratingEnabled={false}
        loadDetail={vi.fn().mockResolvedValue({
          id: '11111111-1111-4111-8111-111111111111',
          title: 'Сообщество',
          logoUrl: null,
          isVerified: false,
          description: null,
          memberCount: 5,
          readOnly: true,
        })}
        loadFeed={loadFeed}
        loadChat={loadChat}
        loadRating={vi.fn()}
      />,
    );
    fireEvent.click(await screen.findByRole('tab', { name: 'Чат' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Чат' }));
    expect(await screen.findByText('Чат загрузился')).toBeInTheDocument();
    expect(loadChat).toHaveBeenCalledTimes(1);
    resolveFeed({ items: [] });
  });

  it('keeps detail loading and retry errors inside the LK shell', async () => {
    const loadDetail = vi.fn().mockRejectedValueOnce(new Error('temporary')).mockResolvedValueOnce({
      id: '11111111-1111-4111-8111-111111111111',
      title: 'Сообщество после повтора',
      logoUrl: null,
      isVerified: false,
      description: null,
      memberCount: 5,
      readOnly: true,
    });
    render(
      <CommunityReadOnlyPage
        communityId="11111111-1111-4111-8111-111111111111"
        feedEnabled
        chatEnabled={false}
        ratingEnabled={false}
        loadDetail={loadDetail}
        loadFeed={vi.fn().mockResolvedValue({ items: [] })}
        loadChat={vi.fn()}
        loadRating={vi.fn()}
      />,
    );

    expect(screen.getByRole('link', { name: 'Назад к сообществам' })).toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent('Не удалось загрузить сообщество');
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    expect(await screen.findByText('Сообщество после повтора')).toBeInTheDocument();
    expect(loadDetail).toHaveBeenCalledTimes(2);
  });

  it('isolates a failed feed and retries it without showing a false empty state', async () => {
    const loadFeed = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValueOnce({ items: [] });
    render(
      <CommunityReadOnlyPage
        communityId="11111111-1111-4111-8111-111111111111"
        feedEnabled
        chatEnabled={false}
        ratingEnabled={false}
        loadDetail={vi.fn().mockResolvedValue({
          id: '11111111-1111-4111-8111-111111111111',
          title: 'Сообщество',
          logoUrl: null,
          isVerified: false,
          description: null,
          memberCount: 5,
          readOnly: true,
        })}
        loadFeed={loadFeed}
        loadChat={vi.fn()}
        loadRating={vi.fn()}
      />,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent('Раздел временно недоступен');
    expect(screen.queryByText('В ленте пока нет публикаций.')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    expect(await screen.findByText('В ленте пока нет публикаций.')).toBeInTheDocument();
    expect(loadFeed).toHaveBeenCalledTimes(2);
  });

  it('keeps a loaded tab visible while another tab loads in the background', async () => {
    let resolveChat!: (value: {
      items: Array<{
        body: string;
        sentAt: string;
        author: { displayName: string };
        isViewer: boolean;
      }>;
    }) => void;
    const loadChat = vi.fn(
      () => new Promise<Parameters<typeof resolveChat>[0]>((resolve) => (resolveChat = resolve)),
    );
    render(
      <CommunityReadOnlyPage
        communityId="11111111-1111-4111-8111-111111111111"
        feedEnabled
        chatEnabled
        ratingEnabled={false}
        loadDetail={vi.fn().mockResolvedValue({
          id: '11111111-1111-4111-8111-111111111111',
          title: 'Сообщество',
          logoUrl: null,
          isVerified: false,
          description: null,
          memberCount: 5,
          readOnly: true,
        })}
        loadFeed={vi.fn().mockResolvedValue({
          items: [
            {
              kind: 'SYSTEM',
              title: null,
              body: 'Готовая лента',
              publishedAt: '2026-08-11T09:00:00.000Z',
              author: { displayName: 'Система' },
            },
          ],
        })}
        loadChat={loadChat}
        loadRating={vi.fn()}
      />,
    );

    expect(await screen.findByText('Готовая лента')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Чат' }));
    expect(screen.getByRole('status')).toHaveTextContent('Загружаем раздел');
    fireEvent.click(screen.getByRole('tab', { name: 'Лента' }));
    expect(screen.getByText('Готовая лента')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    await act(async () => {
      resolveChat({
        items: [
          {
            body: 'Фоновый чат загружен',
            sentAt: '2026-08-11T10:00:00.000Z',
            author: { displayName: 'Анна' },
            isViewer: false,
          },
        ],
      });
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole('tab', { name: 'Чат' }));
    expect(screen.getByText('Фоновый чат загружен')).toBeInTheDocument();
  });

  it('does not clear an active chat loading state when the initial feed fails', async () => {
    let rejectFeed!: (reason?: unknown) => void;
    let resolveChat!: (value: { items: [] }) => void;
    const loadFeed = vi.fn(() => new Promise<never>((_resolve, reject) => (rejectFeed = reject)));
    const loadChat = vi.fn(() => new Promise<{ items: [] }>((resolve) => (resolveChat = resolve)));
    render(
      <CommunityReadOnlyPage
        communityId="11111111-1111-4111-8111-111111111111"
        feedEnabled
        chatEnabled
        ratingEnabled={false}
        loadDetail={vi.fn().mockResolvedValue({
          id: '11111111-1111-4111-8111-111111111111',
          title: 'Сообщество',
          logoUrl: null,
          isVerified: false,
          description: null,
          memberCount: 5,
          readOnly: true,
        })}
        loadFeed={loadFeed}
        loadChat={loadChat}
        loadRating={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByRole('tab', { name: 'Чат' }));
    await act(async () => {
      rejectFeed(new Error('feed failed'));
      await Promise.resolve();
    });
    expect(screen.getByRole('status')).toHaveTextContent('Загружаем раздел');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await act(async () => {
      resolveChat({ items: [] });
      await Promise.resolve();
    });
    expect(await screen.findByText('В чате пока нет сообщений.')).toBeInTheDocument();
  });

  it('retains independent feed and chat errors until each section is retried', async () => {
    let rejectFeed!: (reason?: unknown) => void;
    let rejectChat!: (reason?: unknown) => void;
    const loadFeed = vi
      .fn()
      .mockImplementationOnce(() => new Promise<never>((_resolve, reject) => (rejectFeed = reject)))
      .mockResolvedValueOnce({ items: [] });
    const loadChat = vi
      .fn()
      .mockImplementationOnce(() => new Promise<never>((_resolve, reject) => (rejectChat = reject)))
      .mockResolvedValueOnce({ items: [] });
    render(
      <CommunityReadOnlyPage
        communityId="11111111-1111-4111-8111-111111111111"
        feedEnabled
        chatEnabled
        ratingEnabled={false}
        loadDetail={vi.fn().mockResolvedValue({
          id: '11111111-1111-4111-8111-111111111111',
          title: 'Сообщество',
          logoUrl: null,
          isVerified: false,
          description: null,
          memberCount: 5,
          readOnly: true,
        })}
        loadFeed={loadFeed}
        loadChat={loadChat}
        loadRating={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByRole('tab', { name: 'Чат' }));
    await act(async () => {
      rejectFeed(new Error('feed failed'));
      await Promise.resolve();
    });
    await act(async () => {
      rejectChat(new Error('chat failed'));
      await Promise.resolve();
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Чат временно недоступен');

    fireEvent.click(screen.getByRole('tab', { name: 'Лента' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Раздел временно недоступен');
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    expect(await screen.findByText('В ленте пока нет публикаций.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Чат' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Чат временно недоступен');
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    expect(await screen.findByText('В чате пока нет сообщений.')).toBeInTheDocument();
    expect(loadFeed).toHaveBeenCalledTimes(2);
    expect(loadChat).toHaveBeenCalledTimes(2);
  });
});
