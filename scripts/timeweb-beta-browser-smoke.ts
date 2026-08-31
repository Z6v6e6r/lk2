#!/usr/bin/env node

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import WebSocket from 'ws';

import { classifyWriteAttempt } from './timeweb-beta-candidate-contract.js';

const GAME_ID = '751fe6a8-b0b1-4b2b-873d-a2d785c4e191';
const USER_ID = '00000000-0000-4000-8000-000000000001';
const TENANT_ID = '00000000-0000-4000-8000-000000000002';

export const TIMEWEB_BROWSER_SMOKE_ROUTES = [
  { path: '/?smokeAuth=none', marker: 'Войти по номеру телефона', name: 'login' },
  { path: '/', marker: 'Анна Петрова', name: 'home' },
  { path: '/profile', marker: 'Анна Петрова', name: 'profile' },
  { path: '/games', marker: 'Рейтинговая игра вечером', name: 'games' },
  { path: `/games/${GAME_ID}`, marker: 'Рейтинговая игра вечером', name: 'game-detail' },
  { path: '/notifications', marker: 'Уведомления', name: 'notifications' },
  { path: '/chats', marker: 'Чаты', name: 'chats' },
] as const;

export interface BrowserWriteCounters {
  CREATE_ATTEMPTS: number;
  JOIN_ATTEMPTS: number;
  PAYMENT_ATTEMPTS: number;
  PROVIDER_WRITES: number;
  OTHER_WRITE_ATTEMPTS: number;
  UNKNOWN_READS: number;
}

export function emptyBrowserWriteCounters(): BrowserWriteCounters {
  return {
    CREATE_ATTEMPTS: 0,
    JOIN_ATTEMPTS: 0,
    PAYMENT_ATTEMPTS: 0,
    PROVIDER_WRITES: 0,
    OTHER_WRITE_ATTEMPTS: 0,
    UNKNOWN_READS: 0,
  };
}

export function incrementWriteCounter(
  counters: BrowserWriteCounters,
  method: string,
  url: string,
): BrowserWriteCounters {
  const next = { ...counters };
  const kind = classifyWriteAttempt(method, url);
  if (kind === 'CREATE') next.CREATE_ATTEMPTS += 1;
  else if (kind === 'JOIN') next.JOIN_ATTEMPTS += 1;
  else if (kind === 'PAYMENT') next.PAYMENT_ATTEMPTS += 1;
  else if (kind === 'PROVIDER') next.PROVIDER_WRITES += 1;
  else if (kind === 'OTHER') next.OTHER_WRITE_ATTEMPTS += 1;
  return next;
}

function browserFixtures(): Record<string, unknown> {
  const session = {
    accessToken: 'synthetic-browser-token',
    tokenType: 'Bearer',
    expiresAt: '2099-09-01T00:00:00.000Z',
    user: { id: USER_ID, displayName: 'Анна Петрова' },
    context: {
      userId: USER_ID,
      tenantId: TENANT_ID,
      displayName: 'Анна Петрова',
      phoneLast4: '0001',
      roles: ['client'],
      permissions: ['profile.read'],
      runtimeCapabilities: {
        communityDirectory: false,
        communityReadDetail: false,
        communityReadFeed: false,
        communityReadChat: false,
        communityReadRating: false,
        communityCanonical: false,
        communityDirectInvites: false,
        communityRealtime: false,
      },
    },
  };
  const game = {
    id: GAME_ID,
    revision: 8,
    surface: 'MY_UPCOMING',
    displayState: 'ONE_SPOT_LEFT',
    title: 'Рейтинговая игра вечером',
    kind: 'RATING',
    visibility: 'PUBLIC',
    startsAt: '2026-09-02T15:00:00.000Z',
    endsAt: '2026-09-02T16:00:00.000Z',
    timezone: 'Europe/Moscow',
    station: {
      id: 'a8df730b-6a67-41a5-8772-48bca84f73bc',
      name: 'Селигерская',
      shortAddress: null,
    },
    court: { id: 'bd35543d-c565-443a-bd3d-eea68eb2fbe6', name: 'Корт №3' },
    levelRange: { from: 'C', to: 'C+' },
    rosterState: 'LAST_SPOT',
    capacity: { total: 4, occupied: 3, reserved: 0, open: 1, waitlistCount: 0 },
    participants: [
      {
        userId: USER_ID,
        displayName: 'Анна',
        avatarUrl: null,
        level: 'C',
        levelValue: 3.2,
        role: 'ORGANIZER',
      },
      {
        userId: '00000000-0000-4000-8000-000000000003',
        displayName: 'Борис',
        avatarUrl: null,
        level: 'C',
        levelValue: 3.3,
        role: 'PLAYER',
      },
      {
        userId: '00000000-0000-4000-8000-000000000004',
        displayName: 'Вера',
        avatarUrl: null,
        level: 'C+',
        levelValue: 3.8,
        role: 'PLAYER',
      },
    ],
    priceSummary: null,
    viewerRelation: 'PARTICIPANT',
    viewerPaymentState: 'NOT_REQUIRED',
    resultSummary: null,
    badges: ['RATING'],
    allowedActions: ['OPEN_DETAILS'],
    deepLink: `/games/${GAME_ID}`,
    conversation: null,
  };
  const homeDashboard = {
    snapshot: {
      version: 'browser-smoke-home-v1',
      generatedAt: '2026-09-01T00:00:00.000Z',
      staleAt: '2099-09-01T00:00:00.000Z',
      source: 'LOCAL_MOCK',
    },
    profile: {
      userId: USER_ID,
      displayName: 'Анна Петрова',
      firstName: 'Анна',
      avatarUrl: null,
      phoneLast4: '0001',
      balanceMinor: 0,
      currency: 'RUB',
      level: { label: 'C+', value: 3.8, assessmentRequired: false },
    },
    counters: { unreadChats: 1, upcomingEvents: 1, activeSubscriptions: 0 },
    quickActions: [
      {
        id: 'play',
        title: 'Найти игру',
        subtitle: 'Открытые игры рядом',
        route: '/games',
        tone: 'violet',
      },
    ],
    upcoming: [
      {
        id: GAME_ID,
        kind: 'game',
        title: game.title,
        startsAt: game.startsAt,
        endsAt: game.endsAt,
        venue: 'Селигерская · корт 3',
        status: 'confirmed',
        route: `/games/${GAME_ID}`,
      },
    ],
    subscriptions: [],
    communities: [],
    promotion: null,
    promotions: { rotationEnabled: false, intervalSeconds: 6, items: [] },
    locations: [],
    additionalLinks: [],
    capabilities: {
      canCreateGame: false,
      canManageTournaments: false,
      canViewCommunities: false,
    },
  };
  const homeBase = {
    snapshot: {
      version: 'browser-smoke-home-base-v1',
      generatedAt: '2026-09-01T00:00:00.000Z',
      source: 'LOCAL_PROJECTION',
      completeness: 'COMPLETE',
    },
    viewerUserId: USER_ID,
    quickActions: homeDashboard.quickActions,
    communities: {
      status: 'READY',
      revision: '1',
      observedAt: '2026-09-01T00:00:00.000Z',
      staleAt: '2099-09-01T00:00:00.000Z',
      value: [],
    },
    promotions: {
      status: 'READY',
      revision: '1',
      observedAt: '2026-09-01T00:00:00.000Z',
      staleAt: '2099-09-01T00:00:00.000Z',
      value: {
        hero: homeDashboard.promotions,
        standard: homeDashboard.promotions,
      },
    },
    locations: [],
    additionalLinks: [],
    capabilities: homeDashboard.capabilities,
  };
  const eventCatalog = {
    state: 'READY',
    snapshotVersion: 'a'.repeat(64),
    generatedAt: '2026-09-01T00:00:00.000Z',
    staleAt: '2099-09-01T00:00:00.000Z',
    items: [{ kind: 'GAME', game: { ...game, surface: 'DISCOVER', viewerRelation: 'NONE' } }],
    nextCursor: null,
    totalMatched: 1,
    facets: { kinds: [], categories: [], stations: [] },
    sourceStatus: [
      { source: 'LOCAL_GAMES', localDate: null, state: 'READY', errorCode: null },
      { source: 'SCHEDULE', localDate: null, state: 'READY', errorCode: null },
      { source: 'TOURNAMENTS', localDate: null, state: 'READY', errorCode: null },
    ],
  };
  return { session, game, homeDashboard, homeBase, eventCatalog };
}

export function buildBrowserFixturePrelude(): string {
  const fixtures = browserFixtures();
  return `(() => {
    const fixtures = ${JSON.stringify(fixtures)};
    const counters = ${JSON.stringify(emptyBrowserWriteCounters())};
    const originalFetch = window.fetch.bind(window);
    window.__PHUB_BROWSER_SMOKE__ = counters;
    window.__PHUB_BROWSER_SMOKE_UNKNOWN_READS__ = [];
    window.WebSocket = class RehearsalWebSocket {
      static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
      readyState = 3;
      addEventListener() {} removeEventListener() {} close() {} send() {}
    };
    const json = (body, status = 200) => new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json', 'X-Correlation-ID': 'browser-smoke' },
    });
    const apiBody = (pathname) => {
      if (/\\/routing-plan$/.test(pathname)) return {
        revision: '1', mode: 'PADLHUB_ONLY', issuedAt: '2026-09-01T00:00:00.000Z',
        expiresAt: '2099-09-01T00:00:00.000Z', operations: [],
      };
      if (/\\/home\\/base$/.test(pathname)) return fixtures.homeBase;
      if (/\\/home$/.test(pathname)) return fixtures.homeDashboard;
      if (/\\/profile\\/privacy$/.test(pathname)) return {
        contactPolicy: 'AUTHORIZED', chatPolicy: 'AUTHORIZED', version: 1,
        updatedAt: '2026-09-01T00:00:00.000Z',
      };
      if (/\\/profile\\/booking-preferences$/.test(pathname)) return {
        favoriteStationIds: [],
        preferredTimeWindows: [{ weekday: 'ANY', startsAt: '09:00', endsAt: '22:00' }],
        useHistory: true, recommendFriends: true, recommendationDisplay: 'CARDS',
        version: 0, updatedAt: null,
      };
      if (/\\/profile\\/friends(?:\\?|$)/.test(pathname)) return { items: [] };
      if (/\\/profile\\/level(?:\\?|$)/.test(pathname)) return {
        sportCode: 'PADEL', scaleVersion: 1, levels: [], currentLevel: null,
      };
      if (/\\/profile$/.test(pathname)) return fixtures.homeDashboard.profile;
      if (/\\/bookings\\/upcoming$/.test(pathname)) return {
        version: fixtures.homeDashboard.snapshot.version,
        generatedAt: fixtures.homeDashboard.snapshot.generatedAt,
        staleAt: fixtures.homeDashboard.snapshot.staleAt,
        items: fixtures.homeDashboard.upcoming,
      };
      if (/\\/recommendations\\/bookings/.test(pathname)) return {
        version: 'a'.repeat(64), generatedAt: '2026-09-01T00:00:00.000Z',
        staleAt: '2099-09-01T00:00:00.000Z', personalization: 'BASIC',
        items: [], nextCursor: null,
      };
      if (/\\/event-catalog/.test(pathname)) return fixtures.eventCatalog;
      if (/\\/games\\/${GAME_ID}$/.test(pathname)) return { game: fixtures.game };
      if (/\\/games(?:\\?|$)/.test(pathname)) return { items: [fixtures.game], nextCursor: null };
      if (/\\/conversations(?:\\?|$)/.test(pathname)) return {
        items: [{
          id: '22222222-2222-4222-8222-222222222222', kind: 'DIRECT',
          participant: { userId: '00000000-0000-4000-8000-000000000003', displayName: 'Борис' },
          unreadCount: 1, updatedAt: '2026-09-01T00:00:00.000Z',
          lastMessage: { sequence: 1, body: 'До встречи на корте', createdAt: '2026-09-01T00:00:00.000Z' },
        }],
      };
      if (/\\/notifications(?:\\?|$)/.test(pathname)) return {
        unreadCount: 1,
        items: [{ id: '33333333-3333-4333-8333-333333333333', category: 'GAME',
          title: 'Игра уже скоро', body: 'Начало завтра в 18:00.', deepLink: '/games/${GAME_ID}',
          createdAt: '2026-09-01T00:00:00.000Z' }],
      };
      if (/\\/(?:web-push\\/configuration|notification-endpoints\\/web\\/config)$/.test(pathname)) return {
        enabled: false, reason: 'GLOBAL_GATE_DISABLED',
      };
      if (/\\/communities\\/mine/.test(pathname)) return { items: [] };
      if (/\\/locations(?:\\?|$)/.test(pathname)) return { items: [] };
      return undefined;
    };
    window.fetch = async (input, init = {}) => {
      const request = input instanceof Request ? input : null;
      const url = new URL(request ? request.url : String(input), window.location.href);
      const method = String(init.method || request?.method || 'GET').toUpperCase();
      const isApi = /^\\/(?:user|public|admin)\\/api\\//.test(url.pathname) || /^\\/health\\//.test(url.pathname);
      if (!isApi || url.origin !== window.location.origin) return originalFetch(input, init);
      if (/\\/auth\\/session\\/refresh$/.test(url.pathname) && method === 'POST') {
        if (new URLSearchParams(window.location.search).get('smokeAuth') === 'none') {
          return json({ code: 'AUTH_REQUIRED', message: 'Synthetic unauthenticated view', correlationId: 'browser-smoke' }, 401);
        }
        return json(fixtures.session);
      }
      if (/\\/booking-screen-read-jobs$/.test(url.pathname) && method === 'POST') {
        return json({
          jobId: '41000000-0000-4000-8000-000000000001', screen: 'EVENT_CATALOG',
          expiresAt: '2099-09-01T00:02:00.000Z', commands: [], concurrency: 1,
        });
      }
      if (/\\/booking-screen-read-jobs\\/41000000-0000-4000-8000-000000000001\\/complete$/.test(url.pathname) && method === 'POST') {
        return json({ screen: 'EVENT_CATALOG', state: 'READY', completedCommands: 0,
          totalCommands: 0, catalog: fixtures.eventCatalog });
      }
      if (method !== 'GET' && method !== 'HEAD') {
        const path = url.pathname;
        if (/\\/games\\/?$/.test(path) && method === 'POST') counters.CREATE_ATTEMPTS += 1;
        else if (/\\/games\\/[^/]+\\/(?:join|waitlist)(?:\\/join)?$/.test(path)) counters.JOIN_ATTEMPTS += 1;
        else if (/payment|gift-certificate-(?:orders|payments)|purchase/i.test(path)) counters.PAYMENT_ATTEMPTS += 1;
        else if (/\\/auth\\/viva\\/(?:authorize|reauthorize|access|callback)$/.test(path)) counters.PROVIDER_WRITES += 1;
        else counters.OTHER_WRITE_ATTEMPTS += 1;
        return json({ code: 'REHEARSAL_WRITE_BLOCKED', message: 'Write blocked', correlationId: 'browser-smoke' }, 405);
      }
      if (url.pathname === '/health/ready') return json({ status: 'ready' });
      const body = apiBody(url.pathname + url.search);
      if (body !== undefined) return json(body);
      counters.UNKNOWN_READS += 1;
      window.__PHUB_BROWSER_SMOKE_UNKNOWN_READS__.push(url.pathname + url.search);
      return json({ code: 'REHEARSAL_FIXTURE_MISSING', message: 'Read fixture missing', correlationId: 'browser-smoke' }, 404);
    };
  })();`;
}

interface CdpMessage {
  readonly id?: number;
  readonly method?: string;
  readonly result?: unknown;
  readonly error?: { readonly message?: string };
  readonly params?: unknown;
}

class CdpClient {
  private sequence = 0;
  private readonly pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void }
  >();
  public readonly exceptions: string[] = [];

  public constructor(private readonly socket: WebSocket) {
    socket.on('message', (data) => {
      const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
      const message = JSON.parse(bytes.toString('utf8')) as CdpMessage;
      if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message ?? 'CDP command failed'));
        else pending.resolve(message.result);
        return;
      }
      if (message.method === 'Runtime.exceptionThrown') {
        this.exceptions.push(JSON.stringify(message.params));
      }
      if (message.method === 'Log.entryAdded') {
        const entry = (message.params as { entry?: { level?: string; text?: string } })?.entry;
        if (entry?.level === 'error') this.exceptions.push(entry.text ?? 'browser log error');
      }
    });
  }

  public command<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
}

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error('Chrome DevTools port was not published');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function waitForTarget(port: number, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = (await response.json()) as { type: string; webSocketDebuggerUrl?: string }[];
      const target = targets.find(
        (entry) => entry.type === 'page' && typeof entry.webSocketDebuggerUrl === 'string',
      );
      if (target?.webSocketDebuggerUrl) return target.webSocketDebuggerUrl;
    } catch {
      // Chrome can publish the port before the first page target is ready.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Chrome page target was unavailable');
}

async function connectWebSocket(url: string): Promise<WebSocket> {
  return await new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

async function evaluate<T>(client: CdpClient, expression: string): Promise<T> {
  const response = await client.command<{
    result: { value?: T; description?: string };
    exceptionDetails?: unknown;
  }>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
  return response.result.value as T;
}

async function waitForMarker(client: CdpClient, marker: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const found = await evaluate<boolean>(
      client,
      `document.body?.innerText.includes(${JSON.stringify(marker)}) === true`,
    ).catch(() => false);
    if (found) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const debug = await evaluate<{ text: string; counters: unknown; unknownReads: unknown }>(
    client,
    `({ text: document.body?.innerText ?? '', counters: window.__PHUB_BROWSER_SMOKE__, unknownReads: window.__PHUB_BROWSER_SMOKE_UNKNOWN_READS__ })`,
  ).catch(() => ({ text: '', counters: null, unknownReads: null }));
  throw new Error(
    `browser marker missing: ${marker}; state=${JSON.stringify({ ...debug, text: debug.text.slice(0, 500) })}`,
  );
}

function chromeExecutable(): string {
  const configured = process.env.TIMEWEB_REHEARSAL_CHROME_PATH?.trim();
  if (configured) return configured;
  return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
}

function stopChrome(processHandle: ChildProcess): void {
  if (processHandle.exitCode !== null) return;
  processHandle.kill('SIGTERM');
  const killTimer = setTimeout(() => {
    if (processHandle.exitCode === null) processHandle.kill('SIGKILL');
  }, 2_000);
  killTimer.unref();
}

export async function runTimewebBrowserSmoke(baseUrl: string): Promise<BrowserWriteCounters> {
  const normalizedBaseUrl = new URL(baseUrl);
  if (!['127.0.0.1', 'localhost'].includes(normalizedBaseUrl.hostname))
    throw new Error('browser smoke accepts only a loopback base URL');
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'phub-timeweb-browser-smoke-'));
  const devtoolsPortFile = join(temporaryRoot, 'DevToolsActivePort');
  const chrome = spawn(
    chromeExecutable(),
    [
      '--headless=new',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-default-apps',
      '--disable-extensions',
      '--disable-sync',
      '--metrics-recording-only',
      '--no-first-run',
      '--remote-debugging-port=0',
      `--user-data-dir=${temporaryRoot}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  let socket: WebSocket | undefined;
  try {
    await waitForFile(devtoolsPortFile, 10_000);
    const [portLine] = readFileSync(devtoolsPortFile, 'utf8').split('\n');
    const port = Number(portLine);
    if (!Number.isSafeInteger(port) || port <= 0) throw new Error('invalid Chrome DevTools port');
    socket = await connectWebSocket(await waitForTarget(port, 10_000));
    const client = new CdpClient(socket);
    await client.command('Page.enable');
    await client.command('Runtime.enable');
    await client.command('Log.enable');
    await client.command('Page.addScriptToEvaluateOnNewDocument', {
      source: buildBrowserFixturePrelude(),
    });

    const totals = emptyBrowserWriteCounters();
    const unknownReadPaths: string[] = [];
    for (const viewport of [
      { name: 'mobile-375', width: 375, height: 812, deviceScaleFactor: 1, mobile: true },
      { name: 'desktop-1440', width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false },
    ] as const) {
      const { name: viewportName, ...deviceMetrics } = viewport;
      await client.command('Emulation.setDeviceMetricsOverride', deviceMetrics);
      for (const route of TIMEWEB_BROWSER_SMOKE_ROUTES) {
        const exceptionOffset = client.exceptions.length;
        await client.command('Page.navigate', {
          url: new URL(route.path, normalizedBaseUrl).toString(),
        });
        await waitForMarker(client, route.marker);
        const pageState = await evaluate<{
          counters: BrowserWriteCounters;
          busy: number;
          errors: string[];
          loadingText: boolean;
          unknownReads: string[];
        }>(
          client,
          `(() => ({
            counters: window.__PHUB_BROWSER_SMOKE__,
            busy: document.querySelectorAll('[aria-busy="true"]').length,
            errors: [...document.querySelectorAll('[data-error-boundary], .error-boundary')].map(node => node.textContent || ''),
            loadingText: /(?:Проверяем сессию|Загружаем нужный раздел|Открываем личный кабинет)/u.test(document.body?.innerText || ''),
            unknownReads: window.__PHUB_BROWSER_SMOKE_UNKNOWN_READS__,
          }))()`,
        );
        if (pageState.busy !== 0 || pageState.loadingText)
          throw new Error(`${viewportName}/${route.name}: infinite spinner or busy state`);
        if (pageState.errors.length > 0)
          throw new Error(`${viewportName}/${route.name}: error boundary rendered`);
        if (client.exceptions.length !== exceptionOffset)
          throw new Error(`${viewportName}/${route.name}: browser exception`);
        for (const key of Object.keys(totals) as (keyof BrowserWriteCounters)[]) {
          totals[key] += pageState.counters[key];
        }
        unknownReadPaths.push(...pageState.unknownReads);

        if (route.name === 'game-detail') {
          await client.command('Page.reload', { ignoreCache: true });
          await waitForMarker(client, route.marker);
          const refreshedBusy = await evaluate<number>(
            client,
            `document.querySelectorAll('[aria-busy="true"]').length`,
          );
          if (refreshedBusy !== 0)
            throw new Error(`${viewportName}/${route.name}: direct refresh did not settle`);
        }
      }
    }
    for (const [key, value] of Object.entries(totals)) {
      if (value !== 0)
        throw new Error(
          `${key}=${value}${key === 'UNKNOWN_READS' ? `|paths=${[...new Set(unknownReadPaths)].join(',')}` : ''}`,
        );
    }
    return totals;
  } finally {
    socket?.close();
    stopChrome(chrome);
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function parseBaseUrl(argv: readonly string[]): string {
  if (argv.length !== 2 || argv[0] !== '--base-url' || !argv[1])
    throw new Error('usage: timeweb-beta-browser-smoke --base-url <loopback-url>');
  return argv[1];
}

if (process.argv[1]?.endsWith('/timeweb-beta-browser-smoke.ts')) {
  runTimewebBrowserSmoke(parseBaseUrl(process.argv.slice(2)))
    .then((counters) => {
      for (const [key, value] of Object.entries(counters))
        process.stdout.write(`${key}=${value}\n`);
      process.stdout.write('TIMEWEB_BROWSER_SMOKE=PASS\n');
    })
    .catch((error: unknown) => {
      process.stderr.write(`TIMEWEB_BROWSER_SMOKE=FAIL|reason=${String(error)}\n`);
      process.exitCode = 1;
    });
}
