// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { webcrypto } from 'node:crypto';
import type { GameCard } from '@phub/api-sdk';
import { App } from '../../web/src/App.js';
import { createBrowserAuthGateway } from '../../web/src/auth-gateway.js';
import { createNativeApiFetch, type AndroidSessionPlugin } from './native-api-fetch.js';
import { IOSGameCancel } from './ios/IOSGameCancel.js';
import {
  auth,
  config,
  game as publicGame,
  fixtureReply,
  nativeResult,
  syntheticSession,
} from './ios/testing/cabinet-fixtures.js';
import type { IOSSessionPlugin } from './ios/session.js';
vi.mock('../../web/src/chat-realtime-client.js', () => ({
  connectChatRealtime: () => ({ stop: () => {} }),
}));
let stopImmediateClick: (() => void) | undefined;
afterEach(() => {
  stopImmediateClick?.();
  stopImmediateClick = undefined;
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});
it.each([
  ['android', 'settled'],
  ['ios', 'settled'],
  ['android', 'immediate'],
  ['ios', 'immediate'],
] as const)(
  '%s %s detail adopts confirmed canonical membership and exposes SELF LEAVE',
  async (platform, clickTiming) => {
    vi.stubGlobal('crypto', webcrypto);
    vi.stubGlobal('scrollTo', vi.fn());
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: { request: async (_n: unknown, _o: unknown, fn: () => unknown) => await fn() },
    });
    let joined = false;
    let revision = 1,
      leaves = 0;
    const game = () =>
      ({
        ...publicGame,
        revision,
        viewerRelation: joined ? 'PARTICIPANT' : 'NONE',
        allowedActions: joined ? ['LEAVE'] : ['JOIN'],
        priceSummary: null,
      }) as GameCard;
    const op = '22222222-2222-4222-8222-222222222222';
    const receipt = {
      commandId: op,
      operation: {
        id: op,
        type: 'JOIN_GAME',
        gameId: publicGame.id,
        status: 'SUCCEEDED',
        aggregateRevision: 2,
        nextAction: { type: 'NONE' },
        error: null,
        commercial: null,
      },
      game: null,
      replayed: false,
    };
    const sent: unknown[] = [];
    let releaseCanonical!: () => void;
    const canonicalGate = new Promise<void>((resolve) => {
      releaseCanonical = resolve;
    });
    let intercepted = false;
    const canonicalRead = async () => {
      if (clickTiming === 'immediate' && joined && revision === 2 && !intercepted) {
        intercepted = true;
        await canonicalGate;
      }
      return { game: game() };
    };
    stopImmediateClick = releaseCanonical;
    if (platform === 'android') {
      const request: AndroidSessionPlugin['request'] = (v) => {
        let data: unknown = { items: [] };
        if (v.path.endsWith('/auth/session/refresh')) data = auth;
        else if (v.path.endsWith('/join')) {
          joined = true;
          revision += 1;
          sent.push(v);
          data = { ...receipt, operation: { ...receipt.operation, aggregateRevision: revision } };
        } else if (v.path.endsWith('/participants/me')) {
          joined = false;
          revision += 1;
          leaves += 1;
          data = {
            ...receipt,
            operation: { ...receipt.operation, type: 'LEAVE_GAME', aggregateRevision: revision },
          };
        } else if (v.path.endsWith('/games/' + publicGame.id))
          return canonicalRead().then((value) => ({
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: Buffer.from(JSON.stringify(value)).toString('base64'),
          }));
        return Promise.resolve({
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: Buffer.from(JSON.stringify(data)).toString('base64'),
        });
      };
      const gateway = createBrowserAuthGateway({
        baseUrl: config.apiBaseUrl,
        tenantKey: config.tenantKey,
        appVersion: 'test',
        platform: 'android',
        nativeSessionTransport: true,
        fetchImplementation: createNativeApiFetch(config, {
          request,
          configuration: () => Promise.resolve(config),
        }),
      });
      window.history.replaceState(null, '', '/games/' + publicGame.id);
      render(<App clientPlatform="android" gateway={gateway} tenantKey={config.tenantKey} />);
    } else {
      const request: IOSSessionPlugin['request'] = (v) => {
        if (v.operation === 'gameJoin') {
          joined = true;
          revision += 1;
          sent.push(v);
          return Promise.resolve(
            nativeResult({
              ...receipt,
              operation: { ...receipt.operation, aggregateRevision: revision },
            }),
          );
        }
        if (v.operation === 'selfLeave') {
          joined = false;
          revision += 1;
          leaves += 1;
          return Promise.resolve(
            nativeResult({
              ...receipt,
              operation: { ...receipt.operation, type: 'LEAVE_GAME', aggregateRevision: revision },
            }),
          );
        }
        if (v.operation === 'read' && v.resource === 'game')
          return canonicalRead().then(nativeResult);
        return Promise.resolve(fixtureReply(v));
      };
      const session = syntheticSession(request);
      await session.restore();
      render(<IOSGameCancel game={game()} session={session} />);
    }
    let clickedImmediately = false;
    if (clickTiming === 'immediate') {
      // A visible action must accept input before the next passive-effect flush.
      const observer = new MutationObserver(() => {
        const button = screen.queryByRole('button', { name: 'Выйти из игры' });
        if (button && !clickedImmediately) {
          clickedImmediately = true;
          fireEvent.click(button);
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      stopImmediateClick = () => {
        observer.disconnect();
        releaseCanonical();
      };
    }
    fireEvent.click(await screen.findByRole('button', { name: 'Присоединиться к игре' }));
    if (clickTiming === 'immediate') {
      await waitFor(() => expect(intercepted).toBe(true));
      releaseCanonical();
      await waitFor(() => expect(clickedImmediately).toBe(true));
      stopImmediateClick?.();
    } else {
      await screen.findByRole('button', { name: 'Выйти из игры' });
    }
    expect(screen.queryByRole('button', { name: 'Присоединиться к игре' })).toBeNull();
    expect(sent).toHaveLength(1);
    if (clickTiming === 'settled')
      fireEvent.click(screen.getByRole('button', { name: 'Выйти из игры' }));
    await screen.findByText('Выход из игры подтверждён.');
    expect(leaves).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: 'Обновить статус игры' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Присоединиться к игре' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Выйти из игры' }));
    await screen.findByText('Выход из игры подтверждён.');
    expect(sent).toHaveLength(2);
    expect(leaves).toBe(2);
  },
);
