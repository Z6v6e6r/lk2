// Commercial acceptance for subscription CREATE60 (quarter owner) and JOIN60 on lk2.padlhub.su.
//
// Default run is READ-ONLY: capability, owner locations, the users' subscriptions with remaining
// units and, when a game is known, the join conditions. It never books or writes anything.
//
//   PHUB_ORGANIZER_TOKEN=... PHUB_JOINER_TOKEN=... npm run lk2:commercial-acceptance
//
// Writes need an explicit flag AND the exact target, because on lk2 the owner is the live LK1
// executor: a confirmed CREATE books a real court in Viva and writes off a subscription visit,
// a confirmed JOIN writes off the joiner's visit. Neither is reversed by this script.
//
//   --create   POST /game-create-operations for PHUB_QUARTER_STATION_ID / PHUB_QUARTER_COURT_ID /
//              PHUB_QUARTER_STARTS_AT with PHUB_ORGANIZER_SUBSCRIPTION_ID
//   --join     POST /games/:id/join for the created game (or PHUB_JOIN_GAME_ID) with
//              PHUB_JOINER_SUBSCRIPTION_ID
//
// Tokens are the users' own PadlHub access tokens (each user signs in themselves); the script
// never prints them. Idempotency keys are kept in LK2_ACCEPTANCE_STATE (default: a file in the OS
// temp directory), so a lost response is recovered by reading the same operation with the same key,
// never by a new POST under a different key.
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const ALLOWED_HOSTS = new Set([
  'lk2.padlhub.su',
  'test.lk2.padlhub.su',
  'localhost',
  '127.0.0.1',
  '[::1]',
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const QUARTER_TERMINAL = new Set([
  'CONFIRMED',
  'REJECTED',
  'EXPIRED_NOT_DISPATCHED',
  'REFUSED_NOT_DISPATCHED',
]);
const JOIN_TERMINAL = new Set(['SUCCEEDED', 'FAILED']);

export function parseArgs(argv) {
  const flags = { create: false, join: false, help: false };
  for (const arg of argv) {
    if (arg === '--create') flags.create = true;
    else if (arg === '--join') flags.join = true;
    else if (arg === '--help' || arg === '-h') flags.help = true;
    else throw new Error(`Unknown argument ${arg}`);
  }
  return flags;
}

export function fileStateStore(path) {
  return {
    load() {
      try {
        return JSON.parse(readFileSync(path, 'utf8'));
      } catch {
        return {};
      }
    },
    save(state) {
      writeFileSync(path, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
    },
  };
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const short = (value) => JSON.stringify(value ?? null).slice(0, 240);

export async function runAcceptance({
  env,
  argv,
  fetchImpl = fetch,
  log = console.log,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
  stateStore,
}) {
  const flags = parseArgs(argv);
  const results = [];
  const record = (name, outcome, detail = '') => {
    const status = outcome === true ? 'PASS' : outcome === false ? 'FAIL' : 'SKIP';
    results.push({ name, status, detail });
    log(`${status}  ${name}${detail ? `  — ${detail}` : ''}`);
    return outcome === true;
  };
  const finish = () => ({
    results,
    failed: results.filter((r) => r.status === 'FAIL').length,
  });

  const baseUrl = (env.PHUB_API_BASE_URL ?? 'https://lk2.padlhub.su').replace(/\/$/, '');
  const host = new URL(baseUrl).host.replace(/:\d+$/, '');
  if (!ALLOWED_HOSTS.has(host)) {
    record('target host is an LK2 contour', false, `refusing ${host}`);
    return finish();
  }
  const tenantKey = env.PHUB_TENANT_KEY ?? 'local-padel';
  const api = `${baseUrl}/user/api/v1/${encodeURIComponent(tenantKey)}`;
  const waitMs = Number(env.LK2_ACCEPTANCE_WAIT_MS ?? 180_000);
  const store =
    stateStore ??
    fileStateStore(env.LK2_ACCEPTANCE_STATE ?? join(tmpdir(), 'lk2-commercial-acceptance.json'));
  const state = store.load();

  async function call(token, method, path, { body, key } = {}) {
    const headers = {
      'X-Correlation-ID': randomUUID(),
      'X-App-Platform': 'web',
      'X-App-Version': 'lk2-commercial-acceptance',
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (key) headers['Idempotency-Key'] = key;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetchImpl(api + path, {
      method,
      headers,
      cache: 'no-store',
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text.slice(0, 200);
    }
    return { status: response.status, json };
  }

  async function until(read, done, intervalMs = 3000) {
    const deadline = now() + waitMs;
    let value = await read();
    while (!done(value) && now() < deadline) {
      await sleep(intervalMs);
      value = await read();
    }
    return value;
  }

  // ADR 0028: /home is never projected on lk2; this route returns one fresh LK1-attested list
  // with PadlHub UUIDs only. state/remainingUnits are display-only (the owner re-verifies).
  async function subscriptions(token) {
    const joinable = await call(token, 'GET', '/subscriptions/joinable');
    if (joinable.status !== 200 || !Array.isArray(joinable.json?.items))
      throw new Error(`/subscriptions/joinable ${joinable.status} ${short(joinable.json)}`);
    return joinable.json.items;
  }
  const usable = (item) =>
    !!item &&
    ['ACTIVE', 'NOT_ACTIVATED'].includes(item.state) &&
    (item.remainingUnits === null || item.remainingUnits > 0);

  function checkSubscription(label, list, id) {
    log(
      `      ${label} subscriptions: ` +
        (list
          .map((s) => `${s.id} "${s.title ?? ''}" ${s.state} remaining=${s.remainingUnits}`)
          .join('; ') || 'none'),
    );
    if (!id) {
      record(
        `${label} subscription selected`,
        null,
        `set PHUB_${label.toUpperCase()}_SUBSCRIPTION_ID`,
      );
      return undefined;
    }
    const item = list.find((s) => s.id === id);
    record(
      `${label} subscription is usable (ACTIVE or NOT_ACTIVATED, units left)`,
      usable(item),
      item
        ? `${item.state} remaining=${item.remainingUnits}`
        : `${id} not in /subscriptions/joinable`,
    );
    return item;
  }

  const organizerToken = env.PHUB_ORGANIZER_TOKEN;
  const joinerToken = env.PHUB_JOINER_TOKEN;
  const organizerSubscriptionId = env.PHUB_ORGANIZER_SUBSCRIPTION_ID;
  const joinerSubscriptionId = env.PHUB_JOINER_SUBSCRIPTION_ID;
  if (!organizerToken) {
    record('organizer signed in', false, 'PHUB_ORGANIZER_TOKEN is required');
    return finish();
  }
  if (joinerToken && joinerToken === organizerToken) {
    record('joiner is a different user', false, 'PHUB_JOINER_TOKEN equals PHUB_ORGANIZER_TOKEN');
    return finish();
  }

  // ---- read-only readiness -------------------------------------------------------------------
  const capability = await call(organizerToken, 'GET', '/game-create-operations/capability');
  const createAvailable = record(
    'quarter CREATE capability is available',
    capability.status === 200 && capability.json?.available === true,
    `${capability.status} ${short(capability.json)}`,
  );
  const target = {
    stationId: env.PHUB_QUARTER_STATION_ID,
    courtId: env.PHUB_QUARTER_COURT_ID,
    startsAt: env.PHUB_QUARTER_STARTS_AT,
  };
  let targetListed = false;
  if (createAvailable) {
    const locations = await call(organizerToken, 'GET', '/game-create-operations/locations');
    const items = Array.isArray(locations.json?.items) ? locations.json.items : [];
    for (const item of items)
      log(`      court ${item.stationId}/${item.courtId} ${item.stationTitle} — ${item.courtName}`);
    if (target.stationId && target.courtId) {
      targetListed = record(
        'selected court is offered by the owner',
        items.some((i) => i.stationId === target.stationId && i.courtId === target.courtId),
        `${items.length} courts listed`,
      );
    } else {
      record(
        'owner offers courts',
        locations.status === 200 && items.length > 0,
        `${items.length} courts`,
      );
    }
  }
  const organizerSubs = await subscriptions(organizerToken).catch((error) => {
    record('organizer subscriptions readable', false, String(error.message));
    return [];
  });
  const organizerSub = checkSubscription('organizer', organizerSubs, organizerSubscriptionId);
  let joinerSubs = [];
  let joinerSub;
  if (joinerToken) {
    joinerSubs = await subscriptions(joinerToken).catch((error) => {
      record('joiner subscriptions readable', false, String(error.message));
      return [];
    });
    joinerSub = checkSubscription('joiner', joinerSubs, joinerSubscriptionId);
  } else {
    record('joiner signed in', null, 'PHUB_JOINER_TOKEN not set: JOIN checks skipped');
  }

  async function joinConditions(gameId) {
    const game = (await call(joinerToken, 'GET', `/games/${gameId}`)).json?.game;
    if (!game?.revision) throw new Error(`game ${gameId} unreadable`);
    const query = new URLSearchParams({
      expectedRevision: String(game.revision),
      subscriptionInstanceId: joinerSubscriptionId,
    });
    const conditions = await call(joinerToken, 'GET', `/games/${gameId}/join-conditions?${query}`);
    const c = conditions.json ?? {};
    const ok =
      conditions.status === 200 &&
      c.eligibility === 'AVAILABLE' &&
      c.subscriptionApplied === true &&
      c.subscriptionInstanceId === joinerSubscriptionId;
    record(
      'join conditions apply the joiner subscription',
      ok,
      `${conditions.status} eligibility=${c.eligibility} applied=${c.subscriptionApplied} ` +
        `free=${c.freeMinutes} paid=${c.paidMinutes} price=${c.price?.amountMinor ?? null} ` +
        `consent=${c.requiresPriceConsent} source=${c.source} provider=${c.providerMode} reason=${c.reasonCode}`,
    );
    return { game, conditions: c, ok };
  }

  const knownGameId = env.PHUB_JOIN_GAME_ID;
  if (!flags.join && joinerToken && joinerSubscriptionId && knownGameId) {
    await joinConditions(knownGameId).catch((error) =>
      record('join conditions apply the joiner subscription', false, String(error.message)),
    );
  }

  async function unitsAfter(token, id, before, label) {
    if (typeof before !== 'number')
      return record(`${label} visit written off once`, null, 'unlimited subscription: no counter');
    const after = await until(
      async () => (await subscriptions(token).catch(() => [])).find((s) => s.id === id),
      (item) => item && item.remainingUnits < before,
      // /subscriptions/joinable is a fresh owner attestation rate-limited to 6/min per user.
      12000,
    );
    if (after && after.remainingUnits === before - 1)
      return record(
        `${label} visit written off once`,
        true,
        `${before} -> ${after.remainingUnits}`,
      );
    if (after && after.remainingUnits < before - 1)
      return record(
        `${label} visit written off once`,
        false,
        `${before} -> ${after.remainingUnits}`,
      );
    return record(
      `${label} visit written off once`,
      null,
      `remaining still ${after?.remainingUnits ?? 'unknown'}: check LK1/Viva (projection may lag)`,
    );
  }

  // ---- CREATE60 by subscription (writes) -----------------------------------------------------
  let createdGameId;
  if (flags.create) {
    const input = {
      stationId: target.stationId,
      courtId: target.courtId,
      startsAt: target.startsAt,
      subscriptionId: organizerSubscriptionId,
    };
    const startsAtMs = Date.parse(input.startsAt ?? '');
    const valid =
      [input.stationId, input.courtId, input.subscriptionId].every((v) => UUID.test(v ?? '')) &&
      Number.isFinite(startsAtMs) &&
      startsAtMs % 60_000 === 0 &&
      startsAtMs > now() &&
      new Date(startsAtMs).toISOString() === input.startsAt;
    if (!valid) {
      record(
        'CREATE target is explicit',
        false,
        'set station, court, minute-aligned future ISO startsAt and subscription',
      );
    } else if (!createAvailable || !targetListed || !usable(organizerSub)) {
      record('CREATE preconditions', false, 'readiness checks above must pass before any write');
    } else {
      const fingerprint = sha256(JSON.stringify(input));
      if (state.create?.fingerprint !== fingerprint) {
        state.create = {
          fingerprint,
          key: `lk2-accept-create-${randomUUID()}`,
          unitsBefore: organizerSub.remainingUnits,
        };
        store.save(state);
      }
      const { key, unitsBefore } = state.create;
      log(`      CREATE idempotency key ${key} (saved in state file)`);
      let view = await call(organizerToken, 'GET', '/game-create-operations/by-key', { key });
      if (view.status === 404)
        view = await call(organizerToken, 'POST', '/game-create-operations', { body: input, key });
      let lastReconcile = -Infinity;
      const read = async () => {
        const current = await call(organizerToken, 'GET', '/game-create-operations/by-key', {
          key,
        });
        // UNKNOWN means the dispatch outcome is ambiguous: recover the SAME operation with the
        // SAME key and body, at most every 30 s, never a fresh create.
        if (
          current.json?.operation?.status === 'UNKNOWN' &&
          UUID.test(current.json.operation.id ?? '') &&
          now() - lastReconcile >= 30_000
        ) {
          lastReconcile = now();
          return call(
            organizerToken,
            'POST',
            `/game-create-operations/${current.json.operation.id}/reconcile`,
            { body: input, key },
          );
        }
        return current;
      };
      const settled = (v) =>
        QUARTER_TERMINAL.has(v.json?.operation?.status) &&
        (v.json.operation.status !== 'CONFIRMED' || !!v.json.gameProjection?.gameId);
      if (!view.json?.operation) {
        record('CREATE accepted by the API', false, `${view.status} ${short(view.json)}`);
        return finish();
      }
      if (!settled(view)) view = await until(read, settled);
      const r = view.json ?? {};
      record(
        'CREATE operation is confirmed by the owner',
        r.operation?.status === 'CONFIRMED' && r.registration?.status === 'CONFIRMED',
        `${view.status} status=${r.operation?.status} registration=${r.registration?.status} reason=${r.reason}`,
      );
      record(
        'CREATE result belongs to the original operation',
        r.keySha256 === sha256(key) &&
          r.request?.subscriptionId === input.subscriptionId &&
          r.request?.stationId === input.stationId &&
          r.request?.courtId === input.courtId &&
          r.request?.startsAt === input.startsAt,
        `operation=${r.operation?.id} draft=${r.operation?.draftId}`,
      );
      createdGameId = r.gameProjection?.gameId ?? undefined;
      if (createdGameId) {
        state.create.gameId = createdGameId;
        store.save(state);
        const game = (await call(organizerToken, 'GET', `/games/${createdGameId}`)).json?.game;
        const minutes = game ? (Date.parse(game.endsAt) - Date.parse(game.startsAt)) / 60_000 : NaN;
        record(
          'created game is a 60-minute game organized by this user',
          game?.viewerRelation === 'ORGANIZER' &&
            minutes === 60 &&
            game.startsAt === input.startsAt,
          `game=${createdGameId} relation=${game?.viewerRelation} minutes=${minutes}`,
        );
        await unitsAfter(organizerToken, input.subscriptionId, unitsBefore, 'organizer');
      } else {
        record('created game is projected', false, 'no gameId in the operation view');
      }
    }
  }

  // ---- JOIN60 by subscription (writes) -------------------------------------------------------
  if (flags.join) {
    const gameId = createdGameId ?? state.create?.gameId ?? knownGameId;
    if (!joinerToken || !UUID.test(joinerSubscriptionId ?? '') || !UUID.test(gameId ?? '')) {
      record(
        'JOIN target is explicit',
        false,
        'set PHUB_JOINER_TOKEN, PHUB_JOINER_SUBSCRIPTION_ID and a game',
      );
    } else if (!usable(joinerSub)) {
      record(
        'JOIN preconditions',
        false,
        'joiner subscription must be active with remaining units',
      );
    } else {
      const { game, conditions, ok } = await joinConditions(gameId).catch((error) => {
        record('join conditions apply the joiner subscription', false, String(error.message));
        return { ok: false };
      });
      if (!ok) {
        record('JOIN preconditions', false, 'join conditions must apply the subscription');
      } else if (conditions.requiresPriceConsent) {
        record(
          'JOIN needs no surcharge',
          false,
          'price consent required: confirm the surcharge in the app instead',
        );
      } else {
        const fingerprint = sha256(JSON.stringify({ gameId, joinerSubscriptionId }));
        if (state.join?.fingerprint !== fingerprint) {
          state.join = {
            fingerprint,
            key: `lk2-accept-join-${randomUUID()}`,
            unitsBefore: joinerSub.remainingUnits,
          };
          store.save(state);
        }
        const { key, unitsBefore } = state.join;
        log(`      JOIN idempotency key ${key} (saved in state file)`);
        let view = await call(joinerToken, 'GET', `/games/${gameId}/join-operation`, { key });
        if (view.status === 404)
          view = await call(joinerToken, 'POST', `/games/${gameId}/join`, {
            body: { expectedRevision: game.revision, subscriptionInstanceId: joinerSubscriptionId },
            key,
          });
        if (!view.json?.operation) {
          record('JOIN accepted by the API', false, `${view.status} ${short(view.json)}`);
          return finish();
        }
        const joined = (v) => JOIN_TERMINAL.has(v.json?.operation?.status);
        if (!joined(view))
          view = await until(
            () => call(joinerToken, 'GET', `/games/${gameId}/join-operation`, { key }),
            joined,
          );
        const op = view.json?.operation ?? {};
        record(
          'JOIN operation succeeded with a provider receipt',
          op.status === 'SUCCEEDED' &&
            op.commercial?.receipt?.status === 'CONFIRMED' &&
            op.gameId === gameId,
          `${view.status} status=${op.status} attempt=${op.commercial?.attemptState} reason=${op.commercial?.reason ?? op.error?.code ?? null}`,
        );
        const after = (await call(joinerToken, 'GET', `/games/${gameId}`)).json?.game;
        record(
          'joiner is a participant',
          after?.viewerRelation === 'PARTICIPANT',
          `relation=${after?.viewerRelation}`,
        );
        await unitsAfter(joinerToken, joinerSubscriptionId, unitsBefore, 'joiner');
      }
    }
  }

  if (!flags.create && !flags.join)
    log(
      "      read-only run: nothing was booked. Use --create / --join only with the owner's approval.",
    );
  return finish();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  let flags;
  try {
    flags = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(String(error.message));
    process.exit(2);
  }
  if (flags.help) {
    console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\nimport ')[0]);
    process.exit(0);
  }
  const { results, failed } = await runAcceptance({
    env: process.env,
    argv: process.argv.slice(2),
  });
  const skipped = results.filter((r) => r.status === 'SKIP').length;
  console.log(
    `\n${results.length - failed - skipped} passed, ${failed} failed, ${skipped} skipped`,
  );
  process.exit(failed ? 1 : 0);
}
