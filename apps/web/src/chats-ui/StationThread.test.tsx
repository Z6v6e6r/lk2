// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { StationThread } from './StationChats.js';
import type { StationSupportDialog, StationSupportMessage } from '../auth-gateway.js';

afterEach(cleanup);

const dialogId = '33333333-3333-4333-8333-333333333333';

const dialog: StationSupportDialog = {
  id: dialogId,
  stationId: '9b993668-ff54-4cce-8dfd-cad84c4a06fa',
  stationName: 'Ясенево',
  status: 'OPEN',
  updatedAt: '2026-09-24T10:00:00.000Z',
  lastMessage: {
    preview: 'Корт свободен',
    author: 'STATION',
    createdAt: '2026-09-24T10:00:00.000Z',
  },
};

function message(index: number): StationSupportMessage {
  return {
    id: `message-${index}`,
    body: `Сообщение ${index}`,
    author: 'STATION',
    authorName: 'Поддержка ПадлХАБ',
    createdAt: `2026-09-24T0${index}:00:00.000Z`,
    attachments: [],
  };
}

/**
 * jsdom has no layout, so the overflow of the timeline is simulated from its own content: every row
 * is worth 100px and the viewport is one row shorter than two rows. That is enough to tell a thread
 * that stops animating at its newest message from one that starts at the first message, and to check
 * that a prepended page keeps the reading position.
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

function thread(overrides: Partial<Parameters<typeof StationThread>[0]> = {}) {
  return (
    <StationThread
      dialog={dialog}
      stationName="Ясенево"
      messages={[message(1)]}
      busy={null}
      error={null}
      closed={false}
      canRetrySend={false}
      hasEarlierMessages={false}
      attachments={[]}
      attachmentsEnabled
      onAttachFiles={vi.fn()}
      onRemoveAttachment={vi.fn()}
      onSendMessage={vi.fn()}
      onRetrySend={vi.fn()}
      onRetry={vi.fn()}
      onLoadEarlier={vi.fn()}
      loadAttachment={vi.fn()}
      {...overrides}
    />
  );
}

function timeline(container: HTMLElement): HTMLOListElement {
  const list = container.querySelector('ol');
  if (!list) throw new Error('the station thread has no timeline');
  return list;
}

describe('station thread reading position', () => {
  it('opens at the newest message instead of the first one', () => {
    const restore = simulateTimelineOverflow();
    try {
      const { container } = render(thread({ messages: [message(1), message(2), message(3)] }));

      const list = timeline(container);
      expect(list.scrollHeight).toBe(300);
      expect(list.scrollTop).toBe(300);
    } finally {
      restore();
    }
  });

  it('keeps the reading position when an older page is prepended above it', () => {
    const restore = simulateTimelineOverflow();
    try {
      const { container, rerender } = render(thread({ messages: [message(2), message(3)] }));
      const list = timeline(container);
      expect(list.scrollTop).toBe(200);

      rerender(thread({ messages: [message(1), message(2), message(3)] }));

      // The two rows that were on screen stay on screen: the shift equals the height that appeared.
      expect(list.scrollHeight).toBe(300);
      expect(list.scrollTop).toBe(300);
    } finally {
      restore();
    }
  });

  it('follows a new answer only while the reader is at the bottom', () => {
    const restore = simulateTimelineOverflow();
    try {
      const { container, rerender } = render(thread({ messages: [message(1), message(2)] }));
      const list = timeline(container);
      expect(list.scrollTop).toBe(200);

      rerender(thread({ messages: [message(1), message(2), message(3)] }));

      expect(list.scrollHeight).toBe(300);
      expect(list.scrollTop).toBe(300);
    } finally {
      restore();
    }
  });
});

describe('station thread older history', () => {
  it('asks for the previous page once when the top edge is reached', () => {
    const onLoadEarlier = vi.fn();
    const restore = simulateTimelineOverflow();
    try {
      const { container } = render(
        thread({ messages: [message(1), message(2)], hasEarlierMessages: true, onLoadEarlier }),
      );

      const list = timeline(container);
      list.scrollTop = 0;
      fireEvent.scroll(list);
      fireEvent.scroll(list);

      expect(onLoadEarlier).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  it('leaves the history alone while the reader is still inside the thread', () => {
    const onLoadEarlier = vi.fn();
    const restore = simulateTimelineOverflow();
    try {
      const { container } = render(
        thread({ messages: [message(1), message(2)], hasEarlierMessages: true, onLoadEarlier }),
      );

      const list = timeline(container);
      list.scrollTop = 150;
      fireEvent.scroll(list);

      expect(onLoadEarlier).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('does not ask for history it does not have and hides the control', () => {
    const onLoadEarlier = vi.fn();
    const restore = simulateTimelineOverflow();
    try {
      const { container } = render(thread({ messages: [message(1), message(2)], onLoadEarlier }));

      fireEvent.scroll(timeline(container));

      expect(onLoadEarlier).not.toHaveBeenCalled();
      expect(screen.queryByRole('button', { name: 'Показать предыдущие сообщения' })).toBeNull();
    } finally {
      restore();
    }
  });
});
