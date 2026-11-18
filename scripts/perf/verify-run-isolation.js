#!/usr/bin/env node
// Proves that a late response stays in the run that started it, and that a frozen snapshot cannot be
// changed by it. Direct HTTP against scripts/perf/stub-lk2-api.js: no browser, no PadlHub API.
//
// Usage: node scripts/perf/verify-run-isolation.js http://127.0.0.1:4180
import { request as httpRequest } from 'node:http';

const base = (process.argv[2] ?? 'http://127.0.0.1:4180').replace(/\/$/, '');

function call(path, { method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(base + path);
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const request = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': payload.length }
          : {},
      },
      (response) => {
        let raw = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          raw += chunk;
        });
        response.on('end', () => {
          let json;
          try {
            json = raw ? JSON.parse(raw) : undefined;
          } catch {
            json = undefined;
          }
          resolve({ status: response.statusCode, json, raw });
        });
      },
    );
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${message}`);
};

const suffix = `tenantKey=padlhub`;
const slowPath = `/user/api/v1/padlhub/profile/booking-preferences?perfDelayMs=1200&${suffix}`;
const fastPath = `/user/api/v1/padlhub/routing-plan?perfDelayMs=1&${suffix}`;

// Run A starts a slow request, then run B begins while that request is still in flight.
const runA = (await call('/__perf/run/begin', { method: 'POST', body: { label: 'A' } })).json.runId;
const slow = call(slowPath);
await sleep(120);
const runB = (await call('/__perf/run/begin', { method: 'POST', body: { label: 'B' } })).json.runId;
const fast = call(fastPath);
await fast;

// Freeze A while its slow request is still in flight, then let it finish: the snapshot must not move
// and the completion must stay in A.
const snapshotA = await call(`/__perf/run/${encodeURIComponent(runA)}/end`, { method: 'POST' });
const snapshotB = await call(`/__perf/run/${encodeURIComponent(runB)}/end`, { method: 'POST' });
const frozenA = snapshotA.raw;
const frozenB = snapshotB.raw;
await slow;

// A late response claims to arrive now: send a request that starts in B but wait for it after B is
// frozen, so B's snapshot has an in-flight entry and A's late completion must not move.
const runC = (await call('/__perf/run/begin', { method: 'POST', body: { label: 'C' } })).json.runId;
const slowInC = call(`/user/api/v1/padlhub/locations?perfDelayMs=900&${suffix}`);
await sleep(60);
const snapshotC = await call(`/__perf/run/${encodeURIComponent(runC)}/end`, { method: 'POST' });
const frozenC = snapshotC.raw;
await slowInC;
await sleep(80);

const againA = await call(`/__perf/run/${encodeURIComponent(runA)}`);
const againB = await call(`/__perf/run/${encodeURIComponent(runB)}`);
const againC = await call(`/__perf/run/${encodeURIComponent(runC)}`);
const live = (await call('/__perf/runs')).json.runs;
const liveA = live.find((run) => run.id === runA);
const liveB = live.find((run) => run.id === runB);
const liveC = live.find((run) => run.id === runC);

check(
  snapshotA.json.aggregates.requests === 1 &&
    snapshotA.json.requests[0]?.endpoint === 'booking-preferences' &&
    snapshotA.json.requests[0]?.completed === false,
  'run A snapshot keeps its slow request as in-flight',
);
check(
  snapshotA.json.aggregates.inFlight === 1,
  'run A snapshot reports the in-flight request instead of dropping it',
);
check(
  snapshotB.json.aggregates.requests === 1 &&
    snapshotB.json.requests[0]?.endpoint === 'routing-plan' &&
    !snapshotB.json.requests.some((request) => request.endpoint === 'booking-preferences'),
  'run B snapshot contains only its own request, not A\u2019s late one',
);
check(
  frozenA === againA.raw && frozenB === againB.raw && frozenC === againC.raw,
  'frozen snapshots are byte-identical after late completions',
);
check(
  liveA.lateCompletions >= 1 && liveA.requests[0]?.completed === true,
  'the late completion stays attributed to run A',
);
check(liveB.lateCompletions === 0, 'run B has no late completions of its own');
check(
  snapshotC.json.aggregates.inFlight === 1 && liveC.lateCompletions >= 1,
  'a request started in run C completes after its snapshot and is counted as C late',
);
const reset = await call('/__perf/reset', { method: 'POST' });
check(reset.status === 409, 'the shared counters cannot be reset by the measurement');

if (failures.length > 0) {
  console.error(`\n${failures.length} isolation check(s) failed`);
  process.exitCode = 1;
} else {
  console.log('\nrun isolation verified');
}
