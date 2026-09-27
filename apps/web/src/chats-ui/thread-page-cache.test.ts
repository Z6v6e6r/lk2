// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { StationSupportMessage } from '../auth-gateway.js';
import type { CommunityChatMessage } from './community-chat-rows.js';
import {
  communityThreadCache,
  createThreadPageCache,
  stationThreadCache,
  threadPageCacheKey,
} from './thread-page-cache.js';

const userId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const threadId = '55555555-5555-4555-8555-555555555555';

function communityMessage(body: string, sentAt: string): CommunityChatMessage {
  return { body, sentAt, author: { displayName: 'Анна' }, isViewer: false };
}

function stationMessage(id: string): StationSupportMessage {
  return {
    id,
    body: `Сообщение ${id}`,
    author: 'STATION',
    authorName: 'Поддержка',
    createdAt: '2026-09-27T12:00:00.000Z',
    attachments: [],
  };
}

beforeEach(() => {
  window.sessionStorage.clear();
});

describe('thread page buffer', () => {
  it('round-trips one thread page per user and thread', () => {
    communityThreadCache.write(userId, threadId, [
      communityMessage('Привет', '2026-09-27T12:00:00.000Z'),
    ]);

    expect(communityThreadCache.read(userId, threadId)).toEqual([
      communityMessage('Привет', '2026-09-27T12:00:00.000Z'),
    ]);
    expect(communityThreadCache.read(userId, '66666666-6666-4666-8666-666666666666')).toBeNull();
    expect(communityThreadCache.read('another-user', threadId)).toBeNull();
  });

  it('keeps the tail of a thread that is longer than the buffer', () => {
    const messages = Array.from({ length: 60 }, (_, index) =>
      communityMessage(
        `Сообщение ${index}`,
        `2026-09-27T${String(index % 24).padStart(2, '0')}:00:00.000Z`,
      ),
    );

    communityThreadCache.write(userId, threadId, messages);

    const buffered = communityThreadCache.read(userId, threadId);
    expect(buffered).toHaveLength(50);
    expect(buffered?.[0]).toEqual(messages[10]);
    expect(buffered?.at(-1)).toEqual(messages[59]);
  });

  it('treats a corrupted or foreign payload as absent', () => {
    window.sessionStorage.setItem(threadPageCacheKey('community-thread', userId, threadId), '{');
    expect(communityThreadCache.read(userId, threadId)).toBeNull();

    window.sessionStorage.setItem(
      threadPageCacheKey('community-thread', userId, threadId),
      JSON.stringify([{ body: 'без автора' }]),
    );
    expect(communityThreadCache.read(userId, threadId)).toBeNull();
  });

  it('does not buffer an empty thread or an implausibly large page', () => {
    communityThreadCache.write(userId, threadId, []);
    expect(communityThreadCache.read(userId, threadId)).toBeNull();

    const huge = Array.from({ length: 5 }, (_, index) =>
      communityMessage('я'.repeat(20_000), `2026-09-27T1${index}:00:00.000Z`),
    );
    communityThreadCache.write(userId, threadId, huge);
    expect(communityThreadCache.read(userId, threadId)).toBeNull();
  });

  it('clears only the thread it is asked about', () => {
    communityThreadCache.write(userId, threadId, [
      communityMessage('Одно', '2026-09-27T12:00:00.000Z'),
    ]);
    stationThreadCache.write(userId, threadId, [stationMessage('1')]);

    communityThreadCache.clear(userId, threadId);

    expect(communityThreadCache.read(userId, threadId)).toBeNull();
    expect(stationThreadCache.read(userId, threadId)).toEqual([stationMessage('1')]);
  });

  it('rejects a station page whose attachment is not an attachment', () => {
    window.sessionStorage.setItem(
      threadPageCacheKey('station-thread', userId, threadId),
      JSON.stringify([{ ...stationMessage('1'), attachments: [{ id: 5 }] }]),
    );

    expect(stationThreadCache.read(userId, threadId)).toBeNull();

    stationThreadCache.write(userId, threadId, [stationMessage('1')]);
    expect(stationThreadCache.read(userId, threadId)).toEqual([stationMessage('1')]);
  });

  it('works without a storage at all', () => {
    const cache = createThreadPageCache<string>({
      name: 'test-thread',
      maxItems: 5,
      maxBytes: 1_024,
      isMessage: (value): value is string => typeof value === 'string',
      storage: () => null,
    });

    expect(cache.read(userId, threadId)).toBeNull();
    expect(() => cache.write(userId, threadId, ['one'])).not.toThrow();
    expect(() => cache.clear(userId, threadId)).not.toThrow();
  });

  it('survives a storage that refuses to write', () => {
    const storage = {
      getItem: vi.fn(),
      setItem: vi.fn(() => {
        throw new Error('QuotaExceededError');
      }),
      removeItem: vi.fn(),
    } as unknown as Storage;
    const cache = createThreadPageCache<string>({
      name: 'test-thread',
      maxItems: 5,
      maxBytes: 1_024,
      isMessage: (value): value is string => typeof value === 'string',
      storage: () => storage,
    });

    expect(() => cache.write(userId, threadId, ['one'])).not.toThrow();
    expect(() => cache.clear(userId, threadId)).not.toThrow();
  });
});
