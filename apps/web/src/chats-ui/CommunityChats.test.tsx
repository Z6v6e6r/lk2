// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CommunityChatList, CommunityThread } from './CommunityChats.js';
import type { CommunityChatMessage, CommunityRow } from './community-chat-rows.js';

afterEach(cleanup);

function community(
  id: string,
  title: string,
  options: { readonly unreadChatCount?: number; readonly logoUrl?: string | null } = {},
): CommunityRow {
  return {
    id,
    title,
    logoUrl: options.logoUrl ?? null,
    isVerified: false,
    unreadChatCount: options.unreadChatCount ?? 0,
    route: `/communities/${id}`,
  };
}

function message(
  sentAt: string,
  body: string,
  author = 'Анна',
  isViewer = false,
): CommunityChatMessage {
  return { body, sentAt, author: { displayName: author }, isViewer };
}

function list(overrides: Partial<Parameters<typeof CommunityChatList>[0]> = {}) {
  return (
    <CommunityChatList
      communities={[community('1', 'Клуб на Соколе')]}
      query=""
      unreadOnly={false}
      hasMore={false}
      selectedCommunityId={null}
      busy={null}
      error={null}
      onSelectCommunity={vi.fn()}
      onRetry={vi.fn()}
      onLoadMore={vi.fn()}
      {...overrides}
    />
  );
}

function thread(overrides: Partial<Parameters<typeof CommunityThread>[0]> = {}) {
  return (
    <CommunityThread
      community={community('1', 'Клуб на Соколе')}
      messages={[message('2026-09-27T11:00:00.000Z', 'Корт свободен')]}
      busy={null}
      error={null}
      hasEarlierMessages={false}
      onRetry={vi.fn()}
      onLoadEarlier={vi.fn()}
      {...overrides}
    />
  );
}

/**
 * jsdom has no layout, so the overflow of the timeline is simulated from its own content: every row
 * is worth 100px and the viewport is one row shorter than two rows. That is enough to tell a thread
 * that opens at its newest message from one that starts at the oldest.
 */
function simulateTimelineOverflow(): () => void {
  const scrollHeight = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get');
  scrollHeight.mockImplementation(function (this: HTMLElement) {
    return this.tagName === 'OL' ? this.querySelectorAll('li').length * 100 : 0;
  });
  const clientHeight = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get');
  clientHeight.mockReturnValue(100);
  return () => {
    scrollHeight.mockRestore();
    clientHeight.mockRestore();
  };
}

function timeline(container: HTMLElement): HTMLOListElement {
  const element = container.querySelector('ol');
  if (!element) throw new Error('the community thread has no timeline');
  return element;
}

describe('community chat list', () => {
  it('lists every community the viewer was added to and opens the selected one', () => {
    const onSelectCommunity = vi.fn();
    render(
      list({
        communities: [
          community('1', 'Клуб на Соколе', { unreadChatCount: 4 }),
          community('2', 'Падел на ВДНХ', { logoUrl: 'https://media.padlhub.ru/wdnh.png' }),
        ],
        onSelectCommunity,
      }),
    );

    const rows = screen.getByRole('list', { name: 'Чаты сообществ' });
    expect(rows.querySelectorAll('li')).toHaveLength(2);
    expect(screen.getByText('Клуб на Соколе')).toBeVisible();
    expect(screen.getByText('Падел на ВДНХ')).toBeVisible();
    expect(screen.getAllByText('Чат сообщества')).toHaveLength(2);
    expect(screen.getByLabelText('Непрочитанных сообщений: 4')).toHaveTextContent('4');
    // The community without artwork keeps the initials fallback of its title.
    expect(screen.getByText('КН')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: /Падел на ВДНХ/ }));
    expect(onSelectCommunity).toHaveBeenCalledWith('2');
  });

  it('searches the member directory and explains an empty result', () => {
    const { rerender } = render(
      list({ communities: [community('1', 'Клуб на Соколе'), community('2', 'Падел на ВДНХ')] }),
    );

    rerender(
      list({
        communities: [community('1', 'Клуб на Соколе'), community('2', 'Падел на ВДНХ')],
        query: 'вднх',
      }),
    );
    expect(screen.queryByText('Клуб на Соколе')).toBeNull();
    expect(screen.getByText('Падел на ВДНХ')).toBeVisible();

    rerender(
      list({
        communities: [community('1', 'Клуб на Соколе'), community('2', 'Падел на ВДНХ')],
        query: 'нет такого',
      }),
    );
    expect(screen.getByRole('status')).toHaveTextContent('По запросу ничего не найдено');
  });

  it('hides read communities while only unread chats are asked for', () => {
    render(
      list({
        communities: [
          community('1', 'Тихий клуб'),
          community('2', 'Активный клуб', { unreadChatCount: 2 }),
        ],
        unreadOnly: true,
      }),
    );

    expect(screen.queryByText('Тихий клуб')).toBeNull();
    expect(screen.getByText('Активный клуб')).toBeVisible();
  });

  it('says that the viewer is not a member of any community yet', () => {
    render(list({ communities: [] }));

    expect(screen.getByRole('status')).toHaveTextContent(
      'Вы пока не вступили ни в одно сообщество',
    );
  });

  it('walks further directory pages from the end of the list', () => {
    const onLoadMore = vi.fn();
    render(list({ hasMore: true, onLoadMore }));

    fireEvent.click(screen.getByRole('button', { name: 'Показать ещё сообщества' }));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it('offers a retry for a failed directory read but not for a switched-off one', () => {
    const { rerender } = render(
      list({
        communities: [],
        error: { kind: 'RETRYABLE', message: 'Не удалось загрузить чаты сообществ.' },
      }),
    );

    expect(screen.getByRole('button', { name: 'Повторить' })).toBeVisible();
    expect(screen.queryByText('Вы пока не вступили ни в одно сообщество')).toBeNull();

    rerender(
      list({
        communities: [],
        error: { kind: 'FEATURE_UNAVAILABLE', message: 'Чаты сообществ ещё не подключены.' },
      }),
    );
    expect(screen.queryByRole('button', { name: 'Повторить' })).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('Чаты сообществ ещё не подключены.');
  });
});

describe('community chat thread', () => {
  it('reads the history in order and states that the chat is read-only', () => {
    render(
      thread({
        messages: [
          message('2026-09-27T11:00:00.000Z', 'Корт свободен в 19:00', 'Анна'),
          message('2026-09-27T11:05:00.000Z', 'Буду', 'Вы', true),
        ],
      }),
    );

    const region = screen.getByRole('region', { name: 'Чат сообщества Клуб на Соколе' });
    const bodies = [...region.querySelectorAll('article p')].map((node) => node.textContent);
    expect(bodies).toEqual(['Корт свободен в 19:00', 'Буду']);
    expect(screen.getByText('Чат сообщества доступен только для чтения.')).toBeVisible();
    expect(screen.getByText('Вы')).toBeVisible();
    // The projection is read-only, so the block must not offer a composer for it.
    expect(screen.queryByLabelText('Сообщение')).toBeNull();
  });

  it('opens at the newest message and keeps the reading position when older history arrives', () => {
    const restore = simulateTimelineOverflow();
    try {
      const { container, rerender } = render(
        thread({
          messages: [
            message('2026-09-26T10:00:00.000Z', 'Раньше'),
            message('2026-09-26T11:00:00.000Z', 'Позже'),
          ],
        }),
      );
      const element = timeline(container);
      expect(element.scrollTop).toBe(200);

      rerender(
        thread({
          messages: [
            message('2026-09-25T10:00:00.000Z', 'Самое раннее'),
            message('2026-09-26T10:00:00.000Z', 'Раньше'),
            message('2026-09-26T11:00:00.000Z', 'Позже'),
          ],
        }),
      );

      expect(element.scrollHeight).toBe(300);
      expect(element.scrollTop).toBe(300);
    } finally {
      restore();
    }
  });

  it('asks for the previous page once when the top edge is reached', () => {
    const onLoadEarlier = vi.fn();
    const restore = simulateTimelineOverflow();
    try {
      const { container } = render(
        thread({
          messages: [message('2026-09-26T10:00:00.000Z', 'Раньше')],
          hasEarlierMessages: true,
          onLoadEarlier,
        }),
      );

      const element = timeline(container);
      element.scrollTop = 0;
      fireEvent.scroll(element);
      fireEvent.scroll(element);

      expect(onLoadEarlier).toHaveBeenCalledTimes(1);
      // The control itself is the discoverable way in, so it stays right above the first message.
      expect(screen.getByRole('button', { name: 'Показать предыдущие сообщения' })).toBeVisible();
    } finally {
      restore();
    }
  });

  it('keeps the history alone while the reader is still inside the thread', () => {
    const onLoadEarlier = vi.fn();
    const restore = simulateTimelineOverflow();
    try {
      const { container } = render(
        thread({
          messages: [
            message('2026-09-26T10:00:00.000Z', 'Раньше'),
            message('2026-09-26T11:00:00.000Z', 'Позже'),
          ],
          hasEarlierMessages: true,
          onLoadEarlier,
        }),
      );

      const element = timeline(container);
      element.scrollTop = 150;
      fireEvent.scroll(element);

      expect(onLoadEarlier).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('explains an empty community chat instead of rendering an empty timeline', () => {
    render(thread({ messages: [] }));

    expect(screen.getByText('В чате сообщества пока нет сообщений.')).toBeVisible();
  });

  it('does not claim the chat is empty when the read itself failed', () => {
    render(thread({ messages: [], error: { kind: 'RETRYABLE', message: 'Чат недоступен.' } }));

    expect(screen.getByRole('status')).toHaveTextContent('Чат недоступен.');
    expect(screen.queryByText('В чате сообщества пока нет сообщений.')).toBeNull();
  });

  it('keeps the same message node when older history is prepended above it', () => {
    const { container, rerender } = render(
      thread({ messages: [message('2026-09-26T11:00:00.000Z', 'Позже')] }),
    );
    const before = container.querySelector('article');

    rerender(
      thread({
        messages: [
          message('2026-09-25T10:00:00.000Z', 'Раньше'),
          message('2026-09-26T11:00:00.000Z', 'Позже'),
        ],
      }),
    );

    // The projection exposes no message id, so the key must not depend on the row position: otherwise
    // an older page would remount every message that is already on screen.
    expect(container.querySelectorAll('article')[1]).toBe(before);
  });

  it('offers a retry for a failed chat read but not for a switched-off projection', () => {
    const { rerender } = render(
      thread({ error: { kind: 'RETRYABLE', message: 'Чат сообщества временно недоступен.' } }),
    );

    expect(screen.getByRole('button', { name: 'Обновить' })).toBeVisible();

    rerender(
      thread({
        error: {
          kind: 'FEATURE_UNAVAILABLE',
          message: 'Чтение чата сообщества ещё не подключено.',
        },
      }),
    );
    expect(screen.queryByRole('button', { name: 'Обновить' })).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Чтение чата сообщества ещё не подключено.',
    );
  });

  it('hides community artwork that fails to load instead of covering the initials', () => {
    render(
      thread({
        community: community('1', 'Клуб на Соколе', {
          logoUrl: 'https://media.padlhub.ru/broken.png',
        }),
      }),
    );

    const image = screen.getByRole('region', { name: /Клуб на Соколе/ }).querySelector('img');
    expect(image).not.toBeNull();
    fireEvent.error(image as HTMLImageElement);

    expect(screen.getByRole('region', { name: /Клуб на Соколе/ }).querySelector('img')).toBeNull();
    expect(screen.getByText('КН')).toBeVisible();
  });

  it('keeps showing artwork after another community logo failed to load', () => {
    const { rerender } = render(
      thread({
        community: community('1', 'Клуб на Соколе', {
          logoUrl: 'https://media.padlhub.ru/broken.png',
        }),
      }),
    );
    fireEvent.error(
      screen
        .getByRole('region', { name: /Клуб на Соколе/ })
        .querySelector('img') as HTMLImageElement,
    );

    // The avatar instance is reused when the thread switches community, so the failure must belong to
    // the artwork that failed, not to the component.
    rerender(
      thread({
        community: community('2', 'Падел на ВДНХ', {
          logoUrl: 'https://media.padlhub.ru/wdnh.png',
        }),
      }),
    );

    const image = screen.getByRole('region', { name: /Падел на ВДНХ/ }).querySelector('img');
    expect(image).not.toBeNull();
    expect(image?.getAttribute('src')).toBe('https://media.padlhub.ru/wdnh.png');
  });
});
