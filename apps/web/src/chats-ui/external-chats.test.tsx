// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { ExternalChatListItem } from './ExternalChatListItem.js';
import { brandLogoUrl } from './brand-logo.js';
import { EXTERNAL_CHAT_DESTINATIONS, externalChatRows } from './external-chats.js';

afterEach(cleanup);

describe('outbound padlhub channels', () => {
  it('ships the three published destinations in the order the list shows them', () => {
    expect(EXTERNAL_CHAT_DESTINATIONS.map((destination) => destination.href)).toEqual([
      'https://t.me/padel_academyF',
      'https://max.ru/id7722810381_biz',
      'https://max.ru/id7722810381_bot',
    ]);
  });

  it('matches the conversation search over the visible title and preview', () => {
    expect(externalChatRows('')).toHaveLength(3);
    expect(externalChatRows('  ')).toHaveLength(3);
    expect(externalChatRows('БОТ').map((destination) => destination.key)).toEqual(['max-bot']);
    expect(externalChatRows('padel_academyf').map((destination) => destination.key)).toEqual([
      'telegram-channel',
    ]);
    expect(externalChatRows('ничего-такого-нет')).toEqual([]);
  });

  it('opens every row in a new tab without handing over the opener', () => {
    render(
      <ul>
        {EXTERNAL_CHAT_DESTINATIONS.map((destination) => (
          <ExternalChatListItem key={destination.key} destination={destination} />
        ))}
      </ul>,
    );

    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(3);
    for (const link of links) {
      expect(link).toHaveAttribute('target', '_blank');
      expect(link.getAttribute('rel')).toContain('noopener');
      expect(link.getAttribute('rel')).toContain('noreferrer');
    }
  });

  it('states the owner of each destination with that brand official logo', () => {
    render(
      <ul>
        {EXTERNAL_CHAT_DESTINATIONS.map((destination) => (
          <ExternalChatListItem key={destination.key} destination={destination} />
        ))}
      </ul>,
    );

    const sources = [...document.querySelectorAll('img')].map((image) => image.getAttribute('src'));
    expect(sources).toEqual([brandLogoUrl('TELEGRAM'), brandLogoUrl('MAX'), brandLogoUrl('MAX')]);
    for (const source of sources) expect(source).toContain('svg');
    // The title next to the logo already names the destination, so the mark stays decorative.
    for (const image of document.querySelectorAll('img')) {
      expect(image).toHaveAttribute('alt', '');
    }
  });

  it('has one distinct official mark per brand', () => {
    expect(brandLogoUrl('TELEGRAM')).not.toBe(brandLogoUrl('MAX'));
  });
});
