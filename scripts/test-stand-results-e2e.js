// Game result entry E2E against the disposable test stand (deploy/test-stand) or a local stack.
//
// A result can be entered only after the Worker has finished the game (endsAt passed), and a game
// closes for joining 30 minutes before its start, so the check runs in two phases:
//
//   npm run stand:e2e:results -- --phase=prepare     # 4-player game starting in ~32 min, 5 min long
//   npm run stand:e2e:results -- --phase=verify      # after the printed time: submit/confirm/dispute
//   npm run stand:e2e:results                        # both, waiting in between (~40 min)
//
// Needs four synthetic phones (AUTH_DEV_PHONE_E164 + 3 in AUTH_DEV_EXTRA_PHONES_E164); a fifth
// enables the non-participant check. It writes synthetic games and results, so it refuses every
// host except the stand and localhost. The game id is kept in STAND_RESULTS_STATE (default: the
// OS temp dir) or passed with --game=<id>.
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseArgs,
  resultGameSchedule,
  resultSubmission,
  standHostAllowed,
} from './test-stand-results.js';

const PHONES = (
  process.env.STAND_E2E_PHONES ?? '+79990000001,+79990000002,+79990000003,+79990000004,+79990000005'
)
  .split(',')
  .map((phone) => phone.trim())
  .filter(Boolean);

const args = parseArgs(process.argv.slice(2));
const baseUrl = (process.env.PHUB_API_BASE_URL ?? 'https://test.lk2.padlhub.su').replace(/\/$/, '');
const tenantKey = process.env.PHUB_TENANT_KEY ?? 'local-padel';
const code = process.env.AUTH_SMOKE_CODE ?? '0000';
const statePath = process.env.STAND_RESULTS_STATE ?? join(tmpdir(), 'phub-stand-results-e2e.json');
if (!standHostAllowed(baseUrl)) {
  console.error(
    `Refusing ${baseUrl}: stand:e2e:results writes synthetic data and runs only on the test stand or localhost.`,
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
    'X-App-Version': 'stand-e2e-results',
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
    await sleep(2000);
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
  return { token: verified.json.accessToken, id: verified.json.user.id, phone };
}

async function loginAll() {
  const users = [];
  for (const phone of PHONES) {
    try {
      users.push(await login(phone));
    } catch (error) {
      if (users.length < 4) throw error;
      console.log(`note: ${phone} is not a stand phone; the non-participant check is skipped`);
      break;
    }
  }
  return users;
}

const readGame = async (user, id) => (await call(user.token, 'GET', `/games/${id}`)).json?.game;
const rosterOf = (game) => (game?.participants ?? []).map((p) => p.userId);

async function prepare(users) {
  const [a, ...joiners] = users.slice(0, 4);
  const locations = await call(a.token, 'GET', '/locations');
  const stationId = locations.json?.items?.[0]?.id;
  if (!stationId) throw new Error(`no stations: ${locations.status} ${short(locations.json)}`);
  const schedule = resultGameSchedule(Date.now(), args.durationMinutes);
  const created = await call(a.token, 'POST', '/games', {
    title: 'E2E ввод счёта',
    kind: 'FRIENDLY',
    visibility: 'PUBLIC',
    stationId,
    startsAt: schedule.startsAt,
    endsAt: schedule.endsAt,
    timezone: 'Europe/Moscow',
    capacity: 4,
    paymentMode: 'NO_PAYMENT',
    waitlistEnabled: false,
  });
  const gameId = created.json?.game?.id ?? created.json?.gameId ?? created.json?.operation?.gameId;
  record(
    'organizer creates a 4-seat game that ends soon',
    created.status < 300 && !!gameId,
    `${created.status} ${gameId ?? short(created.json)}`,
  );
  if (!gameId) return undefined;
  await until(
    () => readGame(a, gameId),
    (game) => game?.revision !== undefined,
  );
  for (const user of joiners) {
    // The card projection can lag a just-applied join, so a stale revision is retried.
    let joined;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const before = await readGame(user, gameId);
      joined = await call(user.token, 'POST', `/games/${gameId}/join`, {
        expectedRevision: before?.revision,
      });
      if (joined.json?.code !== 'GAME_REVISION_CONFLICT') break;
      await sleep(1500);
    }
    if (joined.status >= 300)
      record(`player ${user.phone} joins`, false, `${joined.status} ${joined.json?.code ?? ''}`);
  }
  const full = await until(
    () => readGame(a, gameId),
    (game) => rosterOf(game).length === 4,
  );
  record(
    'four players are in the game',
    rosterOf(full).length === 4,
    `roster=${rosterOf(full).length}`,
  );
  writeFileSync(statePath, JSON.stringify({ baseUrl, gameId, ...schedule }, null, 2));
  console.log(
    `game ${gameId} ends ${schedule.endsAt}; run --phase=verify after ${schedule.verifyAfter}`,
  );
  return { gameId, ...schedule };
}

async function verify(users, gameId, verifyAfter) {
  const [a, b, c, d] = users;
  const outsider = users[4];
  const untilFinished = Math.max(0, (Date.parse(verifyAfter ?? '') || 0) - Date.now());
  const finished = await until(
    () => readGame(a, gameId),
    (game) => (game?.allowedActions ?? []).includes('SUBMIT_RESULT'),
    untilFinished + 10 * 60_000,
  );
  const roster = rosterOf(finished);
  const inGame = [a, b, c, d].every((user) => roster.includes(user.id));
  record(
    'finished game offers result entry to a participant',
    inGame && (finished?.allowedActions ?? []).includes('SUBMIT_RESULT'),
    `result=${finished?.resultSummary?.state ?? 'none'} roster=${roster.length}`,
  );
  if (!inGame || finished?.resultSummary?.state !== 'AWAITING_SUBMISSION') return;

  const teamA = [a.id, b.id];
  const teamB = [c.id, d.id];

  if (outsider) {
    await step('non-participant cannot submit a result', async () => {
      const sent = await call(
        outsider.token,
        'POST',
        `/games/${gameId}/result-submissions`,
        resultSubmission(teamA, teamB, [[6, 4]]),
      );
      record(
        'non-participant cannot submit a result',
        sent.status === 409 && sent.json?.code === 'GAME_RESULT_NOT_PARTICIPANT',
        `${sent.status} ${sent.json?.code ?? ''}`,
      );
    });
  } else {
    record('non-participant cannot submit a result', null, 'needs a fifth stand phone');
  }

  await step('a roster that is not the game roster is refused', async () => {
    const sent = await call(
      a.token,
      'POST',
      `/games/${gameId}/result-submissions`,
      resultSubmission(teamA, [c.id, randomUUID()], [[6, 4]]),
    );
    record(
      'a roster that is not the game roster is refused',
      sent.status === 400 && sent.json?.code === 'GAME_RESULT_INVALID_ROSTER',
      `${sent.status} ${sent.json?.code ?? ''}`,
    );
  });

  let firstSubmissionId;
  await step('participant submits the score', async () => {
    const sent = await call(
      a.token,
      'POST',
      `/games/${gameId}/result-submissions`,
      resultSubmission(teamA, teamB, [
        [6, 4],
        [6, 3],
      ]),
    );
    const game = await until(
      () => readGame(c, gameId),
      (g) => g?.resultSummary?.state === 'PENDING_CONFIRMATION',
    );
    firstSubmissionId = game?.resultSummary?.submissionId;
    record(
      'participant submits the score',
      sent.status === 200 &&
        !!firstSubmissionId &&
        (game?.allowedActions ?? []).includes('CONFIRM_RESULT'),
      `${sent.status} state=${game?.resultSummary?.state} actions=${game?.allowedActions}`,
    );
  });
  if (!firstSubmissionId) return;

  await step('the author cannot confirm their own score', async () => {
    const confirmed = await call(
      a.token,
      'POST',
      `/games/${gameId}/result-submissions/${firstSubmissionId}/confirm`,
    );
    record(
      'the author cannot confirm their own score',
      confirmed.status === 403 && confirmed.json?.code === 'GAME_RESULT_REVIEW_FORBIDDEN',
      `${confirmed.status} ${confirmed.json?.code ?? ''}`,
    );
  });

  await step('another participant disputes the score', async () => {
    const disputed = await call(
      c.token,
      'POST',
      `/games/${gameId}/result-submissions/${firstSubmissionId}/dispute`,
      { reasonCode: 'SCORE_INCORRECT', note: 'E2E: второй сет был 4:6' },
    );
    const game = await until(
      () => readGame(a, gameId),
      (g) => g?.resultSummary?.state === 'DISPUTED',
    );
    record(
      'another participant disputes the score',
      disputed.status === 200 && (game?.allowedActions ?? []).includes('SUBMIT_RESULT'),
      `${disputed.status} state=${game?.resultSummary?.state}`,
    );
  });

  let secondSubmissionId;
  await step('the score is submitted again after the dispute', async () => {
    const sent = await call(
      c.token,
      'POST',
      `/games/${gameId}/result-submissions`,
      resultSubmission(teamA, teamB, [
        [6, 4],
        [4, 6],
        [7, 5],
      ]),
    );
    const game = await until(
      () => readGame(b, gameId),
      (g) =>
        g?.resultSummary?.state === 'PENDING_CONFIRMATION' &&
        g.resultSummary.submissionId !== firstSubmissionId,
    );
    secondSubmissionId = game?.resultSummary?.submissionId;
    record(
      'the score is submitted again after the dispute',
      sent.status === 200 && !!secondSubmissionId && secondSubmissionId !== firstSubmissionId,
      `${sent.status} state=${game?.resultSummary?.state}`,
    );
  });
  if (!secondSubmissionId) return;

  await step('the disputed submission can no longer be confirmed', async () => {
    const confirmed = await call(
      b.token,
      'POST',
      `/games/${gameId}/result-submissions/${firstSubmissionId}/confirm`,
    );
    record(
      'the disputed submission can no longer be confirmed',
      confirmed.status >= 400 && confirmed.status < 500,
      `${confirmed.status} ${confirmed.json?.code ?? ''}`,
    );
  });

  await step('a participant confirms the score', async () => {
    const confirmed = await call(
      b.token,
      'POST',
      `/games/${gameId}/result-submissions/${secondSubmissionId}/confirm`,
    );
    const game = await until(
      () => readGame(d, gameId),
      (g) => g?.resultSummary?.state === 'CONFIRMED',
    );
    const sets = (game?.resultSummary?.sets ?? []).map((set) => `${set.teamA}:${set.teamB}`);
    record(
      'a participant confirms the score',
      confirmed.status === 200 && sets.join(' ') === '6:4 4:6 7:5',
      `${confirmed.status} state=${game?.resultSummary?.state} sets=${sets.join(' ')}`,
    );
  });

  await step('a confirmed result cannot be submitted again', async () => {
    const sent = await call(
      d.token,
      'POST',
      `/games/${gameId}/result-submissions`,
      resultSubmission(teamA, teamB, [[6, 0]]),
    );
    record(
      'a confirmed result cannot be submitted again',
      sent.status === 409,
      `${sent.status} ${sent.json?.code ?? ''}`,
    );
  });
}

function savedGame() {
  if (args.gameId) return { gameId: args.gameId };
  try {
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    if (state.baseUrl === baseUrl) {
      if (Date.parse(state.verifyAfter) > Date.now())
        console.log(`note: the game ends later; waiting until ${state.verifyAfter} (+10 min)`);
      return { gameId: state.gameId, verifyAfter: state.verifyAfter };
    }
  } catch {
    // no saved game for this stand
  }
  return {};
}

const signIn = async () => {
  const users = await loginAll();
  record(
    'four synthetic players sign in',
    users.length >= 4 && new Set(users.map((u) => u.id)).size === users.length,
    `${users.length} phones`,
  );
  return users;
};

let users = await signIn();
let game = args.phase === 'verify' ? savedGame() : {};
if (args.phase !== 'verify') {
  game = (await prepare(users)) ?? {};
  if (game.gameId && args.phase === 'all') {
    const wait = Math.max(0, Date.parse(game.verifyAfter) - Date.now());
    console.log(`waiting ${Math.ceil(wait / 60_000)} min for the game to finish…`);
    await sleep(wait);
    // Access tokens are short-lived; sign in again after the wait.
    users = await signIn();
  }
}
if (args.phase !== 'prepare') {
  if (game.gameId) await verify(users, game.gameId, game.verifyAfter);
  else
    record('a prepared game is available', false, 'run --phase=prepare first or pass --game=<id>');
}

const failed = results.filter((r) => r.status === 'FAIL').length;
const skipped = results.filter((r) => r.status === 'SKIP').length;
console.log(`\n${results.length - failed - skipped} passed, ${failed} failed, ${skipped} skipped`);
process.exit(failed ? 1 : 0);
