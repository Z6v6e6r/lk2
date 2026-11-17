#!/usr/bin/env node
// LOCAL synthetic timing of authorized LK2 screens against scripts/perf/stub-lk2-api.js.
//
// Every scenario runs in real headless Chrome with one throttling profile, the same fixture API
// (fixed read latency), a cleared HTTP cache unless the scenario is a repeat open, and reports:
//   * when the first data-bearing DOM marker appeared,
//   * when each read left the client (so request priority is visible, not just claimed),
//   * how many requests and bytes that run cost.
//
// These are client timings against a synthetic API. They are NOT user measurements, NOT STAGING
// evidence and NOT a run of the installed Android application.
//
// Usage:
//   node scripts/perf/measure-app-scenarios.js http://127.0.0.1:4180/ --runs=7 \
//     --scenarios=home,profile,games,repeat,profile-nav,background [--no-throttle] [--debug]
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const baseUrl = (process.argv[2] ?? 'http://127.0.0.1:4180/').replace(/\/$/, '');
const numberFlag = (name, fallback) => {
  const raw = process.argv.find((value) => value.startsWith(`--${name}=`));
  return raw ? Number(raw.split('=')[1]) : fallback;
};
const runs = numberFlag('runs', 7);
const scenariosFlag = process.argv.find((value) => value.startsWith('--scenarios='));
const scenarioList = (
  scenariosFlag ? scenariosFlag.split('=')[1] : 'home,profile,games,repeat,profile-nav,background'
).split(',');
const throttle = !process.argv.includes('--no-throttle');
const debug = process.argv.includes('--debug');
const chromePath =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const MARKERS = {
  home: "Array.from(document.querySelectorAll('h1,h2')).some((node) => node.textContent.trim() === 'Анна Петрова')",
  profile:
    "document.querySelector('.profile-booking-preferences') !== null || Array.from(document.querySelectorAll('h1,h2,h3')).some((node) => node.textContent.includes('Анна Петрова'))",
  // The /games discovery screen builds its cards from the client-assisted read job
  // (POST /booking-screen-read-jobs + .../complete), which this read-only stub cannot produce.
  // The measured marker is therefore the screen shell; card timing for that route stays unmeasured.
  games: "document.body.innerText.includes('Найти партнёров и корт')",
};
const PATHS = { home: '/', profile: '/profile', games: '/games' };

// Endpoint labels used in the per-run request timeline.
const ENDPOINTS = [
  ['session-refresh', /\/auth\/session\/refresh/],
  ['routing-plan', /\/routing-plan/],
  ['home-base', /\/home\/base/],
  ['home-dashboard', /\/home$/],
  ['self-profile', /\/profile$/],
  ['player-profile', /\/profiles\//],
  ['profile-privacy', /\/profile\/privacy/],
  ['booking-preferences', /\/profile\/booking-preferences/],
  ['friends', /\/profile\/friends$/],
  ['friend-requests', /\/profile\/friend-requests/],
  ['upcoming-bookings', /\/bookings\/upcoming/],
  ['recommendations', /\/recommendations\/bookings/],
  ['locations', /\/locations$/],
  ['communities-mine', /\/communities\/mine/],
  ['conversations', /\/conversations/],
  ['notifications', /\/notifications$/],
  ['notification-preferences', /\/notifications\/preferences/],
  ['public-games', /\/public\/api\/v1\/[^/]+\/games/],
];
function endpointOf(url) {
  const match = ENDPOINTS.find(([, pattern]) => pattern.test(new URL(url).pathname));
  return match ? match[0] : 'other';
}

function launchChrome(profileDir) {
  return spawn(
    chromePath,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-crash-reporter',
      '--disable-breakpad',
      '--remote-debugging-port=0',
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--disable-gpu',
      '--hide-scrollbars',
      '--mute-audio',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
}

async function waitForPort(profileDir, timeoutMs = 20000) {
  const portFile = join(profileDir, 'DevToolsActivePort');
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (existsSync(portFile)) {
      const [port] = readFileSync(portFile, 'utf8').split('\n');
      if (port) return Number(port);
    }
    await sleep(50);
  }
  throw new Error('Chrome did not publish a DevTools port');
}

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = [];
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      }
      if (message.method) {
        for (const handler of this.handlers) handler(message);
      }
    });
  }
  send(method, params = {}) {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP timeout: ${method}`));
      }, 30000);
    });
  }
  onEvent(handler) {
    this.handlers.push(handler);
  }
}

const INSTRUMENT = `(() => {
  window.__PHUB_MARKS = { lcp: 0 };
  try {
    new PerformanceObserver((list) => {
      const entries = list.getEntries();
      if (entries.length) window.__PHUB_MARKS.lcp = entries[entries.length - 1].startTime;
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  } catch {}
})();`;

function httpJson(url) {
  return new Promise((resolve, reject) => {
    import('node:http')
      .then(({ get }) => {
        const request = get(url, (response) => {
          let body = '';
          response.setEncoding('utf8');
          response.on('data', (chunk) => {
            body += chunk;
          });
          response.on('end', () => {
            try {
              resolve(JSON.parse(body));
            } catch (error) {
              reject(error);
            }
          });
        });
        request.on('error', reject);
        request.setTimeout(5000, () => request.destroy(new Error('stub control timeout')));
      })
      .catch(reject);
  });
}

const stubStats = () => httpJson(`${baseUrl}/__perf/stats`);
const stubReset = () => httpJson(`${baseUrl}/__perf/reset`);

async function waitForMarker(cdp, expression, timeoutMs = 25000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const result = await cdp.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
    });
    if (result.result.value === true) return Date.now() - started;
    await sleep(20);
  }
  return null;
}

async function collectRun(cdp, startedAt, requests) {
  const stats = await stubStats();
  const navigation = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const nav = performance.getEntriesByType('navigation')[0];
      return {
        lcp: window.__PHUB_MARKS.lcp,
        domContentLoaded: nav ? nav.domContentLoadedEventEnd : 0,
      };
    })()`,
    returnByValue: true,
  });
  const pageText = debug
    ? (
        await cdp.send('Runtime.evaluate', {
          expression: 'document.body.innerText.slice(0, 300)',
          returnByValue: true,
        })
      ).result.value
    : undefined;
  return {
    firstDataMs: null,
    lcp: navigation.result.value.lcp,
    domContentLoaded: navigation.result.value.domContentLoaded,
    requests: stats.requests.reduce((total, entry) => total + entry.count, 0),
    transferBytes: stats.requests.reduce((total, entry) => total + entry.bytes, 0),
    endpointCounts: Object.fromEntries(
      stats.requests.map((entry) => [entry.endpoint, entry.count]),
    ),
    requestKeys: stats.requests.map((entry) => `${entry.key} ×${entry.count}`),
    requestTimeline: requests.map((request) => ({
      endpoint: request.endpoint,
      startMs: request.startMs,
    })),
    ...(pageText ? { pageText } : {}),
    wallMs: Date.now() - startedAt,
  };
}

let runSequence = 0;

async function runColdScenario(cdp, scenario, options = {}) {
  const url = `${baseUrl}${PATHS[scenario] ?? '/'}`;
  const runId = `run-${++runSequence}`;
  if (!options.keepCache) await cdp.send('Network.clearBrowserCache');
  await cdp.send('Page.navigate', { url: 'about:blank' });
  await sleep(100);
  await stubReset();
  // Every run marks its own document, so a marker left over from the previous page can never be
  // mistaken for this run's first data.
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__PHUB_RUN_ID = '${runId}';${INSTRUMENT}`,
  });

  const requests = [];
  const stop = (message) => {
    if (message.method !== 'Network.requestWillBeSent') return;
    const requestUrl = message.params?.request?.url ?? '';
    if (!requestUrl.startsWith(baseUrl)) return;
    requests.push({ endpoint: endpointOf(requestUrl), startMs: Date.now() - startedAt });
  };
  cdp.onEvent(stop);

  const startedAt = Date.now();
  await cdp.send('Page.navigate', { url });
  const marker = MARKERS[scenario] ?? MARKERS.home;
  const firstData = await waitForMarker(cdp, `window.__PHUB_RUN_ID === '${runId}' && (${marker})`);
  const sample = await collectRun(cdp, startedAt, requests);
  return { ...sample, scenario, firstDataMs: firstData };
}

async function runNavigationScenario(cdp) {
  // Home first, then an in-app route change, which is what "open the profile" means once the user
  // is already inside the cabinet.
  await runColdScenario(cdp, 'home');
  await stubReset();
  const requests = [];
  cdp.onEvent((message) => {
    if (message.method !== 'Network.requestWillBeSent') return;
    const requestUrl = message.params?.request?.url ?? '';
    if (!requestUrl.startsWith(baseUrl)) return;
    requests.push({ endpoint: endpointOf(requestUrl), startMs: Date.now() - startedAt });
  });
  const startedAt = Date.now();
  await cdp.send('Runtime.evaluate', {
    expression:
      "window.history.pushState({}, '', '/profile'); window.dispatchEvent(new PopStateEvent('popstate')); 1",
    returnByValue: true,
  });
  const firstData = await waitForMarker(cdp, MARKERS.profile);
  const sample = await collectRun(cdp, startedAt, requests);
  return { ...sample, scenario: 'profile-nav', firstDataMs: firstData };
}

async function runBackgroundRefresh(cdp) {
  // Warm Home, then measure the refresh that a return from the background triggers.
  await runColdScenario(cdp, 'home');
  await stubReset();
  const startedAt = Date.now();
  let requestAt = null;
  const stop = (message) => {
    if (message.method !== 'Network.requestWillBeSent') return;
    if (!String(message.params?.request?.url ?? '').includes('/home/base')) return;
    requestAt = Date.now() - startedAt;
  };
  cdp.onEvent(stop);
  await cdp.send('Runtime.evaluate', {
    expression:
      "window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); 1",
    returnByValue: true,
  });
  while (Date.now() - startedAt < 15000 && requestAt === null) await sleep(20);
  return { scenario: 'background', refreshRequestMs: requestAt };
}

function stats(values) {
  if (!values.length) return { runs: 0, p50: null, p95: null };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (quantile) =>
    sorted[Math.min(sorted.length - 1, Math.floor(quantile * sorted.length))];
  return { runs: values.length, p50: Math.round(at(0.5)), p95: Math.round(at(0.95)) };
}

function endpointStartStats(samples) {
  const byEndpoint = new Map();
  for (const sample of samples) {
    for (const request of sample.requestTimeline ?? []) {
      const list = byEndpoint.get(request.endpoint) ?? [];
      list.push(request.startMs);
      byEndpoint.set(request.endpoint, list);
    }
  }
  return Object.fromEntries(
    [...byEndpoint.entries()]
      .map(([endpoint, values]) => [endpoint, stats(values)])
      .sort((left, right) => left[1].p50 - right[1].p50),
  );
}

const profileDir = mkdtempSync(join(tmpdir(), 'phub-scenario-'));
const chrome = launchChrome(profileDir);
let socket;
try {
  const port = await waitForPort(profileDir);
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) =>
    response.json(),
  );
  const page = targets.find((target) => target.type === 'page');
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  const cdp = new Cdp(socket);
  await cdp.send('Page.enable');
  await cdp.send('Network.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 412,
    height: 915,
    deviceScaleFactor: 2.625,
    mobile: true,
  });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  if (throttle) {
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 150,
      downloadThroughput: (1.6 * 1024 * 1024) / 8,
      uploadThroughput: (750 * 1024) / 8,
      connectionType: 'cellular4g',
    });
  }

  const results = {};
  for (const scenario of scenarioList) {
    results[scenario] = [];
    for (let run = 0; run < runs; run += 1) {
      if (scenario === 'background') {
        results[scenario].push(await runBackgroundRefresh(cdp));
      } else if (scenario === 'profile-nav') {
        results[scenario].push(await runNavigationScenario(cdp));
      } else if (scenario === 'repeat') {
        if (run === 0) await runColdScenario(cdp, 'home');
        results[scenario].push(await runColdScenario(cdp, 'home', { keepCache: true }));
      } else {
        results[scenario].push(await runColdScenario(cdp, scenario));
      }
    }
  }

  const summary = {};
  for (const [scenario, samples] of Object.entries(results)) {
    summary[scenario] = {
      runs: samples.length,
      firstDataMs:
        scenario === 'background'
          ? undefined
          : stats(samples.map((sample) => sample.firstDataMs).filter((value) => value !== null)),
      refreshRequestMs:
        scenario === 'background'
          ? stats(
              samples.map((sample) => sample.refreshRequestMs).filter((value) => value !== null),
            )
          : undefined,
      lcpMs: stats(samples.map((sample) => sample.lcp).filter((value) => value > 0)),
      domContentLoadedMs: stats(samples.map((sample) => sample.domContentLoaded)),
      requests: stats(samples.map((sample) => sample.requests).filter((value) => value > 0)),
      transferBytes: stats(
        samples.map((sample) => sample.transferBytes).filter((value) => value > 0),
      ),
      requestStartsByEndpoint: endpointStartStats(samples),
      samples,
    };
  }

  console.log(
    JSON.stringify(
      {
        baseUrl,
        mode: throttle ? '4G 1.6Mbps/150ms RTT, CPU 4x slowdown' : 'no network/CPU throttling',
        evidence:
          'LOCAL (synthetic API via scripts/perf/stub-lk2-api.js; client shell timing, not a user measurement)',
        summary,
      },
      null,
      2,
    ),
  );
} finally {
  try {
    socket?.close();
  } catch {}
  chrome.kill('SIGKILL');
  try {
    rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // A leftover temp profile directory is harmless.
  }
}
