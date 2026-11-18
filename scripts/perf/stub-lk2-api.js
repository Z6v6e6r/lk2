#!/usr/bin/env node
// Reproducible stand for measuring the LK2 client on screens that need a session.
//
// It serves the built web shell and answers the small set of read endpoints the first authorized
// screens use, with the fixtures that already prove those screens render
// (scripts/perf/fixtures.js is generated from apps/web/src/App.test.tsx). Every response is delayed
// by PHUB_STUB_LATENCY_MS, so the client sees a realistic read latency without any live API, Viva,
// PostgreSQL or Redis. Nothing here is a PadlHub API: it is a LOCAL, synthetic timing harness.
//
// Usage: node scripts/perf/stub-lk2-api.js <dist-dir> [--port=4180] [--latency=120]
//        PHUB_STUB_LATENCY_MS=120 node scripts/perf/stub-lk2-api.js apps/web/dist
import { createServer } from 'node:http';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { gzipSync } from 'node:zlib';
import * as fixtures from './fixtures.js';

const args = process.argv.slice(2);
const dist = args.find((value) => !value.startsWith('--')) ?? 'apps/web/dist';
const flag = (name, fallback) => {
  const raw = args.find((value) => value.startsWith(`--${name}=`));
  return raw ? Number(raw.split('=')[1]) : fallback;
};
const port = Number(process.env.PHUB_STUB_PORT ?? flag('port', 4180));
const latencyMs = Number(process.env.PHUB_STUB_LATENCY_MS ?? flag('latency', 120));
const tenantKey = process.env.PHUB_STUB_TENANT ?? 'padlhub';
const tenantId = fixtures.session.context.tenant.id;
const userId = fixtures.session.context.user.id;

const sessionDto = {
  accessToken: 'stub-access-token-for-local-measurement',
  tokenType: 'Bearer',
  expiresAt: '2099-01-01T00:00:00.000Z',
  user: { id: userId, displayName: fixtures.session.context.user.displayName },
  context: {
    tenantId,
    userId,
    displayName: fixtures.session.context.user.displayName,
    phoneLast4: '0001',
    roles: fixtures.session.context.roles,
    permissions: fixtures.session.context.permissions,
  },
};

const gameCard = {
  id: '751fe6a8-b0b1-4b2b-873d-a2d785c4e191',
  revision: 7,
  surface: 'DISCOVER',
  displayState: 'ONE_SPOT_LEFT',
  title: 'Рейтинговая игра вечером',
  kind: 'RATING',
  visibility: 'PUBLIC',
  startsAt: '2026-07-20T15:00:00.000Z',
  endsAt: '2026-07-20T16:00:00.000Z',
  timezone: 'Europe/Moscow',
  station: { id: 'a8df730b-6a67-41a5-8772-48bca84f73bc', name: 'Селигерская' },
  court: { id: 'bd35543d-c565-443a-bd3d-eea68eb2fbe6', name: 'Корт №3' },
  levelRange: { from: 'C', to: 'C+' },
  rosterState: 'LAST_SPOT',
  capacity: { total: 4, occupied: 3, reserved: 0, open: 1, waitlistCount: 0 },
  participants: [
    { displayName: 'Анна', avatarUrl: null, level: 'C', role: 'ORGANIZER' },
    { displayName: 'Борис', avatarUrl: null, level: 'C', role: 'PLAYER' },
    { displayName: 'Вера', avatarUrl: null, level: 'C+', role: 'PLAYER' },
  ],
  priceSummary: null,
  viewerRelation: 'ANONYMOUS',
  viewerPaymentState: 'NOT_REQUIRED',
  badges: ['RATING'],
  allowedActions: ['OPEN_DETAILS', 'JOIN'],
  deepLink: '/games/751fe6a8-b0b1-4b2b-873d-a2d785c4e191',
};

// The station list is read from one place in one build and from another in the other build, so the
// fixture must expose the same station ids and names either way. The id/name match `gameCard.station`.
const stationFixtures = {
  items: [
    {
      id: 'a8df730b-6a67-41a5-8772-48bca84f73bc',
      title: 'Селигерская',
      city: 'Москва',
      courtCount: 3,
      coverImageUrl: null,
      route: '/locations/a8df730b-6a67-41a5-8772-48bca84f73bc',
    },
  ],
};

// A read-job answer that is fully local: no Viva, no LK1. The web client starts the job, sees no
// provider commands to execute, and completes it to receive the page.
const recommendationGame = (id) => ({
  id,
  revision: 1,
  surface: 'DISCOVER',
  displayState: 'FINDING_PLAYERS',
  title: 'Открытая игра',
  kind: 'RATING',
  visibility: 'PUBLIC',
  startsAt: '2026-07-30T15:00:00.000Z',
  endsAt: '2026-07-30T16:30:00.000Z',
  timezone: 'Europe/Moscow',
  station: { id: 'a8df730b-6a67-41a5-8772-48bca84f73bc', name: 'Селигерская' },
  court: null,
  levelRange: { from: 'D+', to: 'C' },
  rosterState: 'OPEN',
  capacity: { total: 4, occupied: 1, reserved: 0, open: 3, waitlistCount: 0 },
  participants: [
    {
      userId: '80000000-0000-4000-8000-000000000001',
      displayName: 'Анна Петрова',
      avatarUrl: null,
      level: 'D+',
      role: 'ORGANIZER',
    },
  ],
  priceSummary: null,
  viewerRelation: 'NONE',
  viewerPaymentState: 'NOT_REQUIRED',
  badges: [],
  allowedActions: ['OPEN_DETAILS', 'JOIN'],
  deepLink: '/games/' + id,
  resultSummary: null,
  conversation: null,
});

const recommendationPage = {
  version: 'c'.repeat(64),
  generatedAt: '2026-07-29T09:00:00.000Z',
  staleAt: '2026-07-29T09:05:00.000Z',
  personalization: 'BASIC',
  items: [
    {
      kind: 'GAME',
      game: recommendationGame('70000000-0000-4000-8000-000000000001'),
      reasons: [],
    },
    {
      kind: 'GAME',
      game: recommendationGame('70000000-0000-4000-8000-000000000002'),
      reasons: [],
    },
  ],
  nextCursor: null,
};

const eventCatalogPage = {
  state: 'READY',
  items: [
    {
      kind: 'GAME',
      game: recommendationGame('70000000-0000-4000-8000-000000000011'),
    },
    {
      kind: 'GAME',
      game: recommendationGame('70000000-0000-4000-8000-000000000012'),
    },
  ],
  nextCursor: null,
  totalMatched: 2,
  facets: {},
  sourceStatus: 'READY',
  staleAt: '2026-07-29T09:05:00.000Z',
};

const trainingPage = {
  state: 'READY',
  items: [],
  nextCursor: null,
  sourceStatus: 'READY',
  staleAt: '2026-07-29T09:05:00.000Z',
};

const jobsByScreen = new Map();
const readJobFor = (screen) => ({
  jobId: `perf-read-job-${screen}`,
  screen,
  state: 'READY',
  commands: [],
  concurrency: 1,
  createdAt: '2026-07-29T09:00:00.000Z',
  expiresAt: '2099-01-01T00:00:00.000Z',
});

const routes = [
  ['POST', /\/auth\/session\/refresh$/, () => sessionDto, 'session-refresh'],
  ['DELETE', /\/auth\/session$/, () => ({}), 'logout'],
  [
    'GET',
    /\/routing-plan$/,
    () => ({
      revision: '1',
      mode: 'PADLHUB_ONLY',
      issuedAt: '2026-07-15T08:00:00.000Z',
      expiresAt: '2099-07-15T08:01:00.000Z',
      operations: [],
    }),
    'routing-plan',
  ],
  ['GET', /\/home\/base$/, () => fixtures.homeBase, 'home-base'],
  ['GET', /\/home$/, () => fixtures.homeDashboard, 'home-dashboard'],
  ['GET', /\/profile$/, () => fixtures.homeDashboard.profile, 'self-profile'],
  ['GET', /\/profiles\/[^/]+$/, () => fixtures.userProfile, 'player-profile'],
  ['GET', /\/profile\/privacy$/, () => fixtures.profilePrivacy, 'profile-privacy'],
  [
    'GET',
    /\/profile\/booking-preferences$/,
    () => fixtures.bookingPreferences,
    'booking-preferences',
  ],
  ['GET', /\/profile\/friends$/, () => ({ items: [] }), 'friends'],
  ['GET', /\/profile\/friend-requests$/, () => ({ items: [] }), 'friend-requests'],
  ['GET', /\/bookings\/upcoming$/, () => fixtures.upcomingBookings, 'upcoming-bookings'],
  ['GET', /\/recommendations\/bookings$/, () => fixtures.bookingRecommendations, 'recommendations'],
  ['GET', /\/locations$/, () => stationFixtures, 'locations'],
  ['GET', /\/communities\/mine$/, () => fixtures.communityMemberships, 'communities-mine'],
  ['GET', /\/conversations$/, () => ({ items: [] }), 'conversations'],
  [
    'GET',
    /\/notifications\/preferences$/,
    () => fixtures.notificationPreferences,
    'notification-preferences',
  ],
  ['GET', /\/notifications$/, () => fixtures.notificationInbox, 'notifications'],
  [
    'GET',
    /\/notification-endpoints\/web\/config$/,
    () => ({ enabled: false, reason: 'GLOBAL_GATE_DISABLED' }),
    'webpush-config',
  ],
  [
    'POST',
    /\/realtime\/tickets$/,
    () => ({
      ticket: 'stub-realtime-ticket-for-local-measurement',
      expiresAt: '2099-01-01T00:00:30.000Z',
    }),
    'realtime-ticket',
  ],
  [
    'POST',
    /\/booking-screen-read-jobs$/,
    (_request, body) => {
      const screen = typeof body?.screen === 'string' ? body.screen : 'FOR_ME';
      const job = readJobFor(screen);
      jobsByScreen.set(job.jobId, screen);
      return job;
    },
    'read-job-start',
  ],
  [
    'GET',
    /\/booking-screen-read-jobs\/[^/]+$/,
    (request) => readJobFor(jobsByScreen.get(request.url.split('/').at(-1)) ?? 'FOR_ME'),
    'read-job-poll',
  ],
  [
    'POST',
    /\/booking-screen-read-jobs\/[^/]+\/complete$/,
    (request) => {
      const jobId = request.url.split('/').at(-2) ?? '';
      const screen = jobsByScreen.get(jobId) ?? 'FOR_ME';
      const completion = { jobId, screen, state: 'READY' };
      if (screen === 'EVENT_CATALOG') return { ...completion, catalog: eventCatalogPage };
      if (screen === 'GROUP_TRAININGS') return { ...completion, trainings: trainingPage };
      if (screen === 'MY_BOOKINGS') {
        return { ...completion, upcoming: fixtures.upcomingBookings };
      }
      return { ...completion, page: recommendationPage };
    },
    'read-job-complete',
  ],
  ['POST', /\/booking-screen-read-jobs\/[^/]+\/results\/[^/]+$/, () => ({}), 'read-job-result'],
  [
    'GET',
    /\/public\/api\/v1\/[^/]+\/tournaments$/,
    () => ({ items: [], nextCursor: null }),
    'public-tournaments',
  ],
  [
    'GET',
    /\/trainings\/catalog$/,
    () => ({ items: [], nextCursor: null, state: 'READY' }),
    'training-catalog',
  ],
  [
    'GET',
    /\/event-catalog$/,
    () => ({ items: [], nextCursor: null, state: 'READY' }),
    'event-catalog',
  ],
  [
    'GET',
    /\/public\/api\/v1\/[^/]+\/games$/,
    () => ({ items: [gameCard], nextCursor: null }),
    'public-games',
  ],
];

function readJsonBody(request) {
  return new Promise((resolve) => {
    if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'DELETE') {
      resolve(undefined);
      return;
    }
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) request.destroy();
    });
    request.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : undefined);
      } catch {
        resolve(undefined);
      }
    });
    request.on('error', () => resolve(undefined));
  });
}

const stats = new Map();
function record(name, method, url, bytes) {
  const key = `${method} ${url.split('?')[0]}`;
  const entry = stats.get(key) ?? { key, endpoint: name, count: 0, bytes: 0 };
  entry.count += 1;
  entry.bytes += bytes;
  stats.set(key, entry);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

function send(response, status, headers, body) {
  const acceptsGzip = String(response.req?.headers['accept-encoding'] ?? '').includes('gzip');
  let payload = body;
  const outHeaders = { ...headers };
  if (acceptsGzip && body.length > 512) {
    payload = gzipSync(body);
    outHeaders['Content-Encoding'] = 'gzip';
  }
  outHeaders['Content-Length'] = String(payload.length);
  response.writeHead(status, outHeaders);
  response.end(payload);
}

function serveStatic(request, response, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
  const file = normalize(join(dist, relative));
  if (!file.startsWith(normalize(dist)) || !existsSync(file) || !statSync(file).isFile()) {
    const index = join(dist, 'index.html');
    const body = readFileSync(index);
    return send(
      response,
      200,
      { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' },
      body,
    );
  }
  const body = readFileSync(file);
  const immutable = pathname.startsWith('/assets/');
  send(
    response,
    200,
    {
      'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    },
    body,
  );
}

const server = createServer(async (request, response) => {
  response.req = request;
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  const path = url.pathname;

  if (path === '/__perf/stats') {
    const body = Buffer.from(JSON.stringify({ latencyMs, requests: [...stats.values()] }));
    return send(
      response,
      200,
      { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' },
      body,
    );
  }
  if (path === '/__perf/reset') {
    stats.clear();
    const body = Buffer.from('{}');
    return send(
      response,
      200,
      { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' },
      body,
    );
  }

  // Only API paths consult the route table: a page URL such as "/profile" must reach the static
  // shell, not the profile JSON endpoint.
  const isApiPath = /^\/(?:user|public|admin)\/api\//.test(path);
  const route = isApiPath
    ? routes.find(([method, pattern]) => method === request.method && pattern.test(path))
    : undefined;
  if (route) {
    const [, , handler, name] = route;
    const requestBody = await readJsonBody(request);
    await new Promise((resolve) => setTimeout(resolve, latencyMs));
    const body = Buffer.from(JSON.stringify(handler(request, requestBody)));
    record(name, request.method, path, body.length);
    return send(
      response,
      200,
      {
        'Content-Type': MIME['.json'],
        'Cache-Control': 'no-store',
        'X-Correlation-ID': String(request.headers['x-correlation-id'] ?? 'perf-stub'),
      },
      body,
    );
  }

  if (path.startsWith('/__perf/')) {
    return send(response, 404, { 'Content-Type': MIME['.json'] }, Buffer.from('{}'));
  }

  if (
    path.startsWith('/user/api/') ||
    path.startsWith('/public/api/') ||
    path.startsWith('/admin/api/')
  ) {
    await new Promise((resolve) => setTimeout(resolve, latencyMs));
    const body = Buffer.from(
      JSON.stringify({ code: 'STUB_NOT_IMPLEMENTED', message: 'No fixture for this read.' }),
    );
    record('unimplemented', request.method, path, body.length);
    return send(
      response,
      404,
      { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' },
      body,
    );
  }

  serveStatic(request, response, path);
});

server.listen(port, '127.0.0.1', () => {
  console.log(
    `LK2 perf stub on http://127.0.0.1:${port}/ (dist ${dist}, latency ${latencyMs} ms, tenant ${tenantKey})`,
  );
});
