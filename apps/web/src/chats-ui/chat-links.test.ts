import { describe, expect, it } from 'vitest';

import { splitChatLinks } from './chat-links.js';

function text(value: string): { readonly kind: 'text'; readonly value: string } {
  return { kind: 'text', value };
}

function link(
  value: string,
  href = value,
): {
  readonly kind: 'link';
  readonly value: string;
  readonly href: string;
} {
  return { kind: 'link', value, href };
}

describe('splitChatLinks', () => {
  it('keeps ordinary text as one segment', () => {
    expect(splitChatLinks('Корт свободен в 19:00')).toEqual([text('Корт свободен в 19:00')]);
    expect(splitChatLinks('')).toEqual([]);
  });

  it('turns a pasted http(s) address into a link between its sentences', () => {
    expect(splitChatLinks('Ссылка на корт: https://padlhub.ru/games/1 — приходи')).toEqual([
      text('Ссылка на корт: '),
      link('https://padlhub.ru/games/1'),
      text(' — приходи'),
    ]);
  });

  it('links a whole message that is only an address, without empty text segments', () => {
    expect(splitChatLinks('http://padlhub.ru')).toEqual([link('http://padlhub.ru')]);
  });

  it('accepts an upper-case scheme and host', () => {
    expect(splitChatLinks('HTTPS://PADLHUB.RU/GAMES')).toEqual([
      link('HTTPS://PADLHUB.RU/GAMES', 'HTTPS://PADLHUB.RU/GAMES'),
    ]);
  });

  it('links a bare host only for a well-known TLD, adding https for the destination', () => {
    expect(splitChatLinks('заходи на padlhub.ru/games')).toEqual([
      text('заходи на '),
      link('padlhub.ru/games', 'https://padlhub.ru/games'),
    ]);
    expect(splitChatLinks('см. vk.com')).toEqual([text('см. '), link('vk.com', 'https://vk.com')]);
  });

  it('links www hosts and hosts with a port', () => {
    expect(splitChatLinks('www.padlhub.ru')).toEqual([
      link('www.padlhub.ru', 'https://www.padlhub.ru'),
    ]);
    expect(splitChatLinks('padlhub.ru:8443/games')).toEqual([
      link('padlhub.ru:8443/games', 'https://padlhub.ru:8443/games'),
    ]);
  });

  it('leaves a multi-label host with an unknown TLD inert unless it carries a scheme', () => {
    expect(splitChatLinks('это mysite.community')).toEqual([text('это mysite.community')]);
    expect(splitChatLinks('https://mysite.community')).toEqual([link('https://mysite.community')]);
  });

  it('keeps sentence punctuation and unbalanced brackets outside the link', () => {
    expect(splitChatLinks('(см. https://padlhub.ru).')).toEqual([
      text('(см. '),
      link('https://padlhub.ru'),
      text(').'),
    ]);
    expect(splitChatLinks('https://ru.wikipedia.org/wiki/Функция_(математика)')).toEqual([
      link('https://ru.wikipedia.org/wiki/Функция_(математика)'),
    ]);
  });

  it('does not link ordinary Russian abbreviations, file names or versions', () => {
    for (const body of ['и т.д. и т.п.', 'смета.xlsx', 'версия 5.5', 'цена 1.000 руб.']) {
      expect(splitChatLinks(body), body).toEqual([text(body)]);
    }
  });

  it('does not link a host that is part of an e-mail address', () => {
    for (const body of ['пишите на boris@padlhub.ru', 'padlhub.ru@evil.example']) {
      expect(splitChatLinks(body), body).toEqual([text(body)]);
    }
  });

  it('never links a non-http scheme or a broken address', () => {
    for (const body of [
      'javascript:alert(1)',
      'data:text/html;base64,PHNjcmlwdD4=',
      'mailto:boris@padlhub.ru',
      'https://',
    ]) {
      expect(splitChatLinks(body), body).toEqual([text(body)]);
    }
  });

  it('leaves a scheme that lost its address as text and links the bare host after it', () => {
    expect(splitChatLinks('https:// padlhub.ru')).toEqual([
      text('https:// '),
      link('padlhub.ru', 'https://padlhub.ru'),
    ]);
  });

  it('links every address in a message with several of them', () => {
    expect(splitChatLinks('https://a.ru и padlhub.ru, ещё https://b.com/x?y=1')).toEqual([
      link('https://a.ru'),
      text(' и '),
      link('padlhub.ru', 'https://padlhub.ru'),
      text(', ещё '),
      link('https://b.com/x?y=1'),
    ]);
  });

  it('keeps the link label byte-identical to what the sender wrote', () => {
    const body = '  https://padlhub.ru/games?date=2026-09-27#top  ';
    const [, segment] = splitChatLinks(body);
    expect(segment).toEqual(
      link(
        'https://padlhub.ru/games?date=2026-09-27#top',
        'https://padlhub.ru/games?date=2026-09-27#top',
      ),
    );
  });
});
