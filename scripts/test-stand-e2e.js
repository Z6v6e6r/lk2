// Multi-player E2E against the disposable test stand (deploy/test-stand) or a local stack.
// It signs in the synthetic mock phones and writes games, chats, friendships and communities,
// so it refuses every host except the stand and localhost.
//
//   npm run stand:e2e                                   # https://test.lk2.padlhub.su
//   PHUB_API_BASE_URL=http://127.0.0.1:3000 npm run stand:e2e
import { randomUUID } from 'node:crypto';

const ALLOWED_HOSTS = new Set(['test.lk2.padlhub.su', 'localhost', '127.0.0.1', '[::1]']);
const PHONES = ['+79990000001', '+79990000002', '+79990000003'];

const baseUrl = (process.env.PHUB_API_BASE_URL ?? 'https://test.lk2.padlhub.su').replace(/\/$/, '');
const tenantKey = process.env.PHUB_TENANT_KEY ?? 'local-padel';
const code = process.env.AUTH_SMOKE_CODE ?? '0000';
if (!ALLOWED_HOSTS.has(new URL(baseUrl).host.replace(/:\d+$/, ''))) {
  console.error(
    `Refusing ${baseUrl}: stand:e2e writes synthetic data and runs only on the test stand or localhost.`,
  );
  process.exit(2);
}
const api = `${baseUrl}/user/api/v1/${encodeURIComponent(tenantKey)}`;

const results = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const short = (value) => JSON.stringify(value ?? null).slice(0, 200);

function record(name, outcome, detail = '') {
  const status = outcome === true ? 'PASS' : outcome === false ? 'FAIL' : 'SKIP';
  results.push({ name, status });
  console.log(`${status}  ${name}${detail ? `  — ${detail}` : ''}`);
}

async function step(name, fn) {
  try {
    await fn();
  } catch (error) {
    record(name, false, String(error?.message ?? error));
  }
}

async function call(token, method, path, body) {
  const headers = {
    'X-Correlation-ID': randomUUID(),
    'X-App-Platform': 'web',
    'X-App-Version': 'stand-e2e',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (method !== 'GET') headers['Idempotency-Key'] = randomUUID();
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(api + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text.slice(0, 200);
  }
  return { status: response.status, json };
}

async function until(read, predicate, ms = 20_000) {
  const deadline = Date.now() + ms;
  let value = await read();
  while (!predicate(value) && Date.now() < deadline) {
    await sleep(1000);
    value = await read();
  }
  return value;
}

async function login(phone) {
  let challenge = await call(null, 'POST', '/auth/challenges', { method: 'phone_otp', phone });
  // The OTP resend cooldown answers 429 for a phone used moments ago.
  for (let i = 0; i < 8 && challenge.status !== 202; i += 1) {
    await sleep(10_000);
    challenge = await call(null, 'POST', '/auth/challenges', { method: 'phone_otp', phone });
  }
  if (challenge.status !== 202)
    throw new Error(`challenge ${phone}: ${challenge.status} ${short(challenge.json)}`);
  const verified = await call(
    null,
    'POST',
    `/auth/challenges/${challenge.json.challengeId}/verify`,
    {
      code,
      acceptance: { publicOfferAccepted: true, personalDataPolicyAccepted: true },
    },
  );
  if (verified.status !== 200)
    throw new Error(`verify ${phone}: ${verified.status} ${short(verified.json)}`);
  return {
    token: verified.json.accessToken,
    id: verified.json.user.id,
    name: verified.json.context?.displayName,
  };
}

const readGame = async (user, id) => (await call(user.token, 'GET', `/games/${id}`)).json?.game;

async function createGame(user, capacity, title) {
  const locations = await call(user.token, 'GET', '/locations');
  const stationId = locations.json?.items?.[0]?.id;
  if (!stationId) throw new Error(`no stations: ${locations.status} ${short(locations.json)}`);
  const start = new Date(Date.now() + 2 * 24 * 3600e3);
  start.setUTCMinutes(0, 0, 0);
  return call(user.token, 'POST', '/games', {
    title,
    kind: 'FRIENDLY',
    visibility: 'PUBLIC',
    stationId,
    startsAt: start.toISOString(),
    endsAt: new Date(start.getTime() + 90 * 60e3).toISOString(),
    timezone: 'Europe/Moscow',
    capacity,
    paymentMode: 'NO_PAYMENT',
    waitlistEnabled: false,
  });
}

const [a, b, c] = await Promise.all(PHONES.map(login));
record(
  'three synthetic players sign in',
  a.id !== b.id && b.id !== c.id && a.id !== c.id,
  `${a.name} / ${b.name} / ${c.name}`,
);

let gameId;
await step('organizer creates a 2-seat game', async () => {
  const created = await createGame(a, 2, 'E2E последнее место');
  gameId = created.json?.game?.id ?? created.json?.gameId ?? created.json?.operation?.gameId;
  record(
    'organizer creates a 2-seat game',
    created.status < 300 && !!gameId,
    `${created.status} ${gameId ?? short(created.json)}`,
  );
});

if (gameId) {
  await until(
    () => readGame(a, gameId),
    (game) => game?.allowedActions !== undefined,
  );
  let winner;
  let loser;
  await step('two players race for the last seat', async () => {
    const [gameB, gameC] = await Promise.all([readGame(b, gameId), readGame(c, gameId)]);
    const [joinB, joinC] = await Promise.all([
      call(b.token, 'POST', `/games/${gameId}/join`, { expectedRevision: gameB?.revision }),
      call(c.token, 'POST', `/games/${gameId}/join`, { expectedRevision: gameC?.revision }),
    ]);
    const settled = await until(
      () => readGame(a, gameId),
      (game) => game?.capacity?.open === 0,
    );
    const players = settled?.participants?.map((p) => p.userId) ?? [];
    const winners = [b, c].filter((user) => players.includes(user.id));
    [winner] = winners;
    loser = winner === b ? c : b;
    record(
      'two players race for the last seat',
      winners.length === 1 && settled.capacity.occupied === 2,
      `B=${joinB.status} C=${joinC.status} occupied=${settled?.capacity?.occupied}`,
    );
  });

  if (winner) {
    await step('game chat reaches participants only', async () => {
      const conversation = await call(a.token, 'POST', '/conversations/game', { gameId });
      const cid =
        conversation.json?.conversation?.id ??
        conversation.json?.conversationId ??
        conversation.json?.id;
      const text = `E2E: привет от организатора ${randomUUID().slice(0, 8)}`;
      const sent = await call(a.token, 'POST', `/conversations/${cid}/messages`, {
        clientMessageId: randomUUID(),
        body: text,
      });
      const seen = await until(
        () => call(winner.token, 'GET', `/conversations/${cid}/messages?limit=20`),
        (r) => JSON.stringify(r.json ?? '').includes(text),
        15_000,
      );
      const outsider = await call(loser.token, 'GET', `/conversations/${cid}/messages?limit=20`);
      record(
        'game chat between organizer and player',
        conversation.status < 300 &&
          sent.status < 300 &&
          JSON.stringify(seen.json ?? '').includes(text),
        `create=${conversation.status} send=${sent.status}`,
      );
      record(
        'non-participant cannot read the game chat',
        outsider.status >= 400,
        `status=${outsider.status} ${outsider.json?.code ?? ''}`,
      );
    });

    await step('player leaves and the seat reopens', async () => {
      const left = await call(winner.token, 'DELETE', `/games/${gameId}/participants/me`);
      const game = await until(
        () => readGame(a, gameId),
        (g) => g?.capacity?.open === 1,
      );
      record(
        'player leaves and the seat reopens',
        left.status < 300 && game?.capacity?.open === 1,
        `leave=${left.status} open=${game?.capacity?.open}`,
      );
    });

    await step('the other player takes the reopened seat', async () => {
      const before = await readGame(loser, gameId);
      const joined = await call(loser.token, 'POST', `/games/${gameId}/join`, {
        expectedRevision: before?.revision,
      });
      const game = await until(
        () => readGame(a, gameId),
        (g) => !!g?.participants?.some((p) => p.userId === loser.id),
      );
      record(
        'the other player takes the reopened seat',
        joined.status < 300 && !!game?.participants?.some((p) => p.userId === loser.id),
        `join=${joined.status} ${joined.json?.code ?? ''}`,
      );
    });

    await step('non-organizer cannot cancel', async () => {
      const cancelled = await call(loser.token, 'POST', `/games/${gameId}/cancel`, {
        reasonCode: 'ORGANIZER_REQUEST',
      });
      record(
        'non-organizer cannot cancel',
        cancelled.status >= 400,
        `status=${cancelled.status} ${cancelled.json?.code ?? ''}`,
      );
    });

    await step('organizer cancels; participant sees it and is notified', async () => {
      const cancelled = await call(a.token, 'POST', `/games/${gameId}/cancel`, {
        reasonCode: 'ORGANIZER_REQUEST',
      });
      const startedAt = Date.now();
      const game = await until(
        () => readGame(loser, gameId),
        (g) => g?.displayState === 'CANCELLED',
        30_000,
      );
      const settleMs = Date.now() - startedAt;
      // The game id is fresh, so a match is this cancellation, never an older or join notification.
      const isCancellation = (item) =>
        item.deepLink === `/games/${gameId}` && /отмен/i.test(item.title ?? '');
      const after = await until(
        () => call(loser.token, 'GET', '/notifications?limit=20'),
        (r) => (r.json?.items ?? []).some(isCancellation),
      );
      const notified = (after.json?.items ?? []).some(isCancellation);
      record(
        'organizer cancels a game with a participant',
        cancelled.status < 300 && game?.displayState === 'CANCELLED',
        `cancel=${cancelled.status} visibleAfter=${settleMs}ms`,
      );
      // Needs the game notification ruleset; the Test stand workflow provisions it.
      record(
        'participant receives a cancellation notification',
        notified,
        `status=${after.status}`,
      );
    });
  }
}

await step('direct chat between two players', async () => {
  const conversation = await call(b.token, 'POST', '/conversations/direct', { otherUserId: c.id });
  const cid =
    conversation.json?.conversation?.id ??
    conversation.json?.conversationId ??
    conversation.json?.id;
  const sent = await call(b.token, 'POST', `/conversations/${cid}/messages`, {
    clientMessageId: randomUUID(),
    body: 'E2E: личное сообщение',
  });
  const listed = await until(
    () => call(c.token, 'GET', '/conversations?limit=50'),
    (r) => JSON.stringify(r.json ?? '').includes(cid),
    15_000,
  );
  record(
    'direct chat between two players',
    conversation.status < 300 &&
      sent.status < 300 &&
      JSON.stringify(listed.json ?? '').includes(cid),
    `create=${conversation.status} send=${sent.status}`,
  );
});

await step('friend request and acceptance', async () => {
  const requested = await call(a.token, 'POST', `/profile/friends/${c.id}`);
  let accepted = { status: 0 };
  if (requested.json?.status === 'PENDING_OUTGOING' && requested.json.requestId) {
    accepted = await call(
      c.token,
      'POST',
      `/profile/friend-requests/${requested.json.requestId}/accept`,
    );
  }
  const state = await call(a.token, 'GET', `/profile/friends/${c.id}`);
  const friends = await call(a.token, 'GET', '/profile/friends?limit=24');
  record(
    'friend request and acceptance',
    requested.status < 300 &&
      state.json?.status === 'FRIEND' &&
      JSON.stringify(friends.json ?? '').includes(c.id),
    `request=${requested.status} ${requested.json?.status ?? requested.json?.code ?? ''} accept=${accepted.status || 'n/a'} state=${state.json?.status ?? state.status}`,
  );
});

await step('public community: create, discover, join', async () => {
  const created = await call(a.token, 'POST', '/communities', {
    title: `E2E сообщество ${Date.now() % 100_000}`,
    description: 'Проверка стенда',
    visibility: 'PUBLIC',
    joinPolicy: 'INSTANT',
    publishingPreset: 'OPEN_COMMUNITY',
  });
  if (created.status === 429) {
    record(
      'public community: create, discover, join',
      null,
      `daily creation quota reached (${created.json?.code ?? 429})`,
    );
    return;
  }
  const communityId = created.json?.id;
  if (created.status >= 300 || !communityId) {
    record(
      'public community: create, discover, join',
      false,
      `create=${created.status} ${short(created.json)}`,
    );
    return;
  }
  const listed = await until(
    () => call(b.token, 'GET', '/communities?limit=50'),
    (r) => JSON.stringify(r.json ?? '').includes(communityId),
    10_000,
  );
  const me = await call(b.token, 'GET', `/communities/${communityId}/members/me`);
  const revision =
    me.json?.membershipRevision ?? me.json?.revision ?? me.json?.membership?.revision ?? 0;
  const joined = await call(b.token, 'POST', `/communities/${communityId}/members/me/join`, {
    expectedMembershipRevision: revision,
  });
  const mine = await call(b.token, 'GET', '/communities/mine?limit=20');
  record(
    'public community: create, discover, join',
    JSON.stringify(listed.json ?? '').includes(communityId) &&
      joined.status < 300 &&
      JSON.stringify(mine.json ?? '').includes(communityId),
    `join=${joined.status} ${joined.json?.code ?? ''}`,
  );
});

const failed = results.filter((r) => r.status === 'FAIL').length;
const skipped = results.filter((r) => r.status === 'SKIP').length;
console.log(`\n${results.length - failed - skipped} passed, ${failed} failed, ${skipped} skipped`);
process.exit(failed ? 1 : 0);
