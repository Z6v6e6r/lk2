import { describe, expect, it } from 'vitest';

import {
  readPushAttribution,
  rememberAuthContinuation,
  safeCommunityReturnTo,
  takeAuthContinuation,
} from './push-opt-in.js';

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => [...values.keys()][index] ?? null,
    removeItem: (key: string) => {
      values.delete(key);
    },
    setItem: (key: string, value: string) => {
      values.set(key, String(value));
    },
  };
}

describe('safeCommunityReturnTo', () => {
  it('accepts the fixed PadlHub community destinations', () => {
    const community = 'https://padlhub.ru/lk_new?authMode=viva&openCommunity=community_1';
    expect(safeCommunityReturnTo(community)).toBe(new URL(community).toString());
    const reserve = 'https://padlhub.su/lk/padel-jump-exhibition-aaaaaaaa/padel-jump-race.html';
    expect(safeCommunityReturnTo(reserve)).toBe(reserve);
  });

  it('rejects every other redirect target', () => {
    for (const value of [
      null,
      '',
      'https://evil.example/community',
      'http://padlhub.ru/lk_new',
      '//padlhub.ru/lk_new',
      'javascript:alert(1)',
      'https://user:pass@padlhub.ru/lk_new',
      'https://padlhub.ru.evil.example/lk_new',
      'https://padlhub.su/other',
      'https://padlhub.ru/lk_new#fragment',
      'https://padlhub.ru/' + 'a'.repeat(2_100),
    ]) {
      expect(safeCommunityReturnTo(value)).toBeNull();
    }
  });
});

describe('push attribution', () => {
  it('reads only the bounded source slug and a control-free community marker', () => {
    expect(
      readPushAttribution(
        '?returnTo=https%3A%2F%2Fpadlhub.ru%2Flk_new&source=korp-sport-2026&community=community_1794221739126_%D0%BA%D0%BE%D1%80%D0%BF%D1%81%D0%BF%D0%BE%D1%80%D1%82',
      ),
    ).toEqual({
      source: 'korp-sport-2026',
      community: 'community_1794221739126_корпспорт',
    });
    expect(readPushAttribution('?source=KORP-SPORT&community=')).toEqual({});
    expect(readPushAttribution('?source=ok&community=' + 'x'.repeat(201))).toEqual({
      source: 'ok',
    });
    expect(readPushAttribution('?source=' + 'a'.repeat(81))).toEqual({});
  });
});

describe('auth continuation', () => {
  it('stores and restores only the internal push opt-in path once', () => {
    const storage = memoryStorage();
    rememberAuthContinuation('https://lk2.padlhub.su/push?returnTo=abc', storage, 1_000);
    expect(takeAuthContinuation(storage, 2_000)).toBe('/push?returnTo=abc');
    expect(takeAuthContinuation(storage, 2_000)).toBeNull();
  });

  it('does not store other routes', () => {
    const storage = memoryStorage();
    rememberAuthContinuation('https://lk2.padlhub.su/notifications', storage, 1_000);
    expect(takeAuthContinuation(storage, 2_000)).toBeNull();
  });

  it('expires stale continuations and ignores malformed records', () => {
    const storage = memoryStorage();
    rememberAuthContinuation('https://lk2.padlhub.su/push', storage, 1_000);
    expect(takeAuthContinuation(storage, 1_000 + 21 * 60 * 1000)).toBeNull();
    storage.setItem(
      'phub.pushOptIn.authContinuation.v1',
      JSON.stringify({ path: '//evil', at: 1_000 }),
    );
    expect(takeAuthContinuation(storage, 2_000)).toBeNull();
    storage.setItem('phub.pushOptIn.authContinuation.v1', 'not-json');
    expect(takeAuthContinuation(storage, 2_000)).toBeNull();
  });
});
