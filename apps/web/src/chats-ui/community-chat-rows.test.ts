import { describe, expect, it } from 'vitest';

import {
  appendCommunityPage,
  communityMessageKey,
  communityRows,
  communityThreadPage,
  mergeCommunityThreadPage,
  type CommunityChatMessage,
  type CommunityRow,
} from './community-chat-rows.js';

function community(id: string, title: string, unreadChatCount = 0): CommunityRow {
  return {
    id,
    title,
    logoUrl: null,
    isVerified: false,
    unreadChatCount,
    route: `/communities/${id}`,
  };
}

function message(
  sentAt: string,
  body: string,
  displayName = 'Анна',
  isViewer = false,
): CommunityChatMessage {
  return { body, sentAt, author: { displayName }, isViewer };
}

describe('community rows', () => {
  it('keeps every member community in the directory order', () => {
    const rows = communityRows({
      communities: [community('1', 'Первый'), community('2', 'Второй')],
      query: '',
      unreadOnly: false,
    });

    expect(rows.map((row) => row.id)).toEqual(['1', '2']);
  });

  it('matches the search against the title, ignoring case and surrounding spaces', () => {
    const rows = communityRows({
      communities: [
        community('1', 'Клуб на Соколе'),
        community('2', 'Падел на ВДНХ'),
        community('3', 'Игра в Сокольниках'),
      ],
      query: '  СОКОЛ ',
      unreadOnly: false,
    });

    // The match is a case-insensitive substring of the title, so the longer "Сокольники" title is
    // part of the same result set as "Сокол".
    expect(rows.map((row) => row.id)).toEqual(['1', '3']);
  });

  it('drops read communities when only unread ones are asked for', () => {
    const rows = communityRows({
      communities: [community('1', 'Тихий клуб'), community('2', 'Активный клуб', 3)],
      query: '',
      unreadOnly: true,
    });

    expect(rows.map((row) => row.id)).toEqual(['2']);
  });

  it('applies the unread filter together with the search', () => {
    const rows = communityRows({
      communities: [community('1', 'Активный клуб', 3), community('2', 'Активный клуб', 0)],
      query: 'активный',
      unreadOnly: true,
    });

    expect(rows.map((row) => row.id)).toEqual(['1']);
  });
});

describe('community chat paging', () => {
  it('turns a newest-first page into the order a thread reads in', () => {
    const page = {
      items: [
        message('2026-09-27T12:00:00.000Z', 'Новое'),
        message('2026-09-27T11:00:00.000Z', 'Старое'),
      ],
      nextCursor: 'cursor-0000000000000001',
    };

    expect(communityThreadPage(page).map((item) => item.body)).toEqual(['Старое', 'Новое']);
  });

  it('reads a page that arrives oldest-first in the same chronological order', () => {
    const page = {
      items: [
        message('2026-09-27T11:00:00.000Z', 'Старое'),
        message('2026-09-27T12:00:00.000Z', 'Новое'),
      ],
    };

    // The projection exposes a send instant, so the reading order never depends on the page
    // direction: the newest message belongs at the bottom of the thread either way.
    expect(communityThreadPage(page).map((item) => item.body)).toEqual(['Старое', 'Новое']);
  });

  it('merges an earlier page into the same order whatever order it arrives in', () => {
    const current = [message('2026-09-27T12:00:00.000Z', 'Новое')];
    const ascending = {
      items: [
        message('2026-09-26T10:00:00.000Z', 'Старейшее'),
        message('2026-09-26T11:00:00.000Z', 'Старое'),
      ],
    };
    const descending = { items: [...ascending.items].reverse() };

    expect(mergeCommunityThreadPage(current, ascending).messages.map((item) => item.body)).toEqual([
      'Старейшее',
      'Старое',
      'Новое',
    ]);
    expect(mergeCommunityThreadPage(current, descending).messages.map((item) => item.body)).toEqual(
      ['Старейшее', 'Старое', 'Новое'],
    );
  });

  it('counts only the messages an earlier page actually adds', () => {
    const current = [message('2026-09-27T12:00:00.000Z', 'Новое')];

    expect(mergeCommunityThreadPage(current, { items: [...current] })).toEqual({
      messages: current,
      added: 0,
    });
    expect(
      mergeCommunityThreadPage(current, { items: [message('2026-09-26T10:00:00.000Z', 'Старое')] })
        .added,
    ).toBe(1);
  });

  it('keys a message by what the projection exposes', () => {
    const first = message('2026-09-27T12:00:00.000Z', 'Привет', 'Анна');
    const second = message('2026-09-27T12:00:00.000Z', 'Привет', 'Борис');

    expect(communityMessageKey(first)).toBe(communityMessageKey({ ...first }));
    expect(communityMessageKey(first)).not.toBe(communityMessageKey(second));
  });

  it('appends only the communities that are not on screen yet', () => {
    const current = [community('1', 'Первый')];

    expect(
      appendCommunityPage(current, [community('1', 'Первый'), community('2', 'Второй')]).map(
        (row) => row.id,
      ),
    ).toEqual(['1', '2']);
  });
});
