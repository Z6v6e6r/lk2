// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import type * as CapacitorCore from '@capacitor/core';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { IOSAuthApp } from './IOSAuthApp.js';
import { directFixture } from './testing/direct-fixtures.js';
import { peer } from './testing/chat-fixtures.js';
import { syntheticSession } from './testing/cabinet-fixtures.js';
import type { IOSSessionPlugin } from './session.js';

vi.mock('@capacitor/core', async (importOriginal) => {
  const original = await importOriginal<typeof CapacitorCore>();
  return {
    ...original,
    registerPlugin: (name: string) =>
      name === 'PadlHubIOSPush'
        ? {
            status: async () =>
              await Promise.resolve({
                configured: false,
                installationId: 'synthetic',
                pendingRevoke: false,
                state: 'unsupported',
              }),
            suspend: async () =>
              await Promise.resolve({ installationId: 'synthetic', pendingRevoke: false }),
            takeOpened: async () => await Promise.resolve({}),
            addListener: async () => await Promise.resolve({ remove: async () => {} }),
          }
        : original.registerPlugin(name),
  };
});
beforeAll(async () => {
  await import('./IOSCabinet.js');
});
beforeEach(() => {
  vi.stubGlobal('scrollTo', vi.fn());
  window.history.replaceState(null, '', '/');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('iOS participant to direct text conversation', () => {
  it.each([false, true])(
    'opens profile from game, creates or reconciles the chat (lost response %s)',
    async (lost) => {
      const fixture = directFixture();
      fixture.loseResponse(lost);
      const request = vi.fn<IOSSessionPlugin['request']>(
        async (input) => await Promise.resolve(fixture.reply(input)),
      );
      const session = syntheticSession(request);
      await session.restore();
      render(<IOSAuthApp session={session} />);
      await screen.findByRole('main', { name: 'Главная' });
      fireEvent.click(screen.getByRole('link', { name: 'Записи' }));
      fireEvent.click(await screen.findByRole('link', { name: 'Найти игру' }));
      const participant = await screen.findAllByRole('link', {
        name: new RegExp(peer.displayName),
      });
      fireEvent.click(participant[0]!);
      await screen.findByRole('heading', { name: peer.displayName });
      expect(screen.queryByRole('button', { name: /Добавить в друзья/ })).toBeNull();
      expect(document.querySelector('img[src*="protected-photo"]')).toBeNull();
      expect(screen.queryByRole('link', { name: 'Создать игру' })).toBeNull();
      fireEvent.click(screen.getByRole('link', { name: /Открыть чат/ }));
      if (lost) {
        expect(await screen.findByRole('alert')).toHaveTextContent('Не удалось подтвердить');
        const retry = screen.getByRole('button', { name: 'Повторить' });
        retry.focus();
        expect(retry).toHaveFocus();
        fireEvent.click(retry);
      }
      await screen.findByText('До встречи на корте!');
      await waitFor(() => expect(window.location.pathname).toMatch(/^\/chats\/[a-f0-9-]+$/));
      expect(
        request.mock.calls.filter(([input]) => input.resource === 'createDirect'),
      ).toHaveLength(1);
      expect(
        request.mock.calls.some(([input]) => /friend|media|contact/i.test(input.resource ?? '')),
      ).toBe(false);
      fireEvent.click(screen.getByRole('link', { name: 'Профиль' }));
      await screen.findByRole('heading', { name: 'Анна Петрова' });
      fireEvent.click(screen.getByRole('button', { name: 'Выйти из аккаунта' }));
      await screen.findByLabelText('Номер телефона');
      expect(screen.queryByText(peer.displayName)).toBeNull();
    },
  );
});
