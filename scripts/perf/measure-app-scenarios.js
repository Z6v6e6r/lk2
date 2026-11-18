#!/usr/bin/env node
// LOCAL synthetic timing of authorized LK2 screens against scripts/perf/stub-lk2-api.js.
//
// One clock: every request offset is measured on the browser monotonic clock of the navigation's own
// document request, so the DOM marker and the request waterfall share a single time origin.
//
// Per run it records: marker time, per-endpoint waterfall (start/end/bytes), API payload bytes
// separately from the whole network transfer, and (optionally) CSS rule coverage.
//
// These are client timings against a synthetic API. They are NOT user measurements, NOT STAGING
// evidence and NOT a run of the installed Android application.
//
// Usage:
//   node scripts/perf/measure-app-scenarios.js http://127.0.0.1:4180/ --runs=7 \
//     --scenarios=home,profile,profile-nav,games,repeat,background \
//     [--no-throttle] [--debug] [--css-coverage] [--trace=/tmp/home-trace.json]
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const baseUrl = (process.argv[2] ?? 'http://127.0.0.1:4180/').replace(/\/$/, '');
const numberFlag = (name, fallback) => {
  const raw = process.argv.find((value) => value.startsWith(`--${name}=`));
  return raw ? Number(raw.split('=')[1]) : fallback;
};
const stringFlag = (name) => {
  const raw = process.argv.find((value) => value.startsWith(`--${name}=`));
  return raw ? raw.slice(name.length + 3) : undefined;
};
const runs = numberFlag('runs', 7);
const scenariosFlag = process.argv.find((value) => value.startsWith('--scenarios='));
const scenarioList = (
  scenariosFlag ? scenariosFlag.split('=')[1] : 'home,profile,profile-nav,games,repeat,background'
).split(',');
const throttle = !process.argv.includes('--no-throttle');
const debug = process.argv.includes('--debug');
const cssCoverage = process.argv.includes('--css-coverage');
const tracePath = stringFlag('trace');
const chromePath =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Markers only flip when the screen that owns them has its data, not when a shared header appears.
// A marker must combine the DOM signal with the read that owns the data, otherwise a shared name in
// the header would stop the clock before the screen's own data arrived. MessageResource timings are
// relative to the same document origin as the DOM marker.
const dataArrived = (pathFragment) =>
  `performance.getEntriesByType('resource').some((entry) => entry.name.includes('${pathFragment}') && entry.responseEnd > 0)`;

const MARKERS = {
  home: `document.querySelector('.fh-bottom-nav') !== null && Array.from(document.querySelectorAll('h1,h2')).some((node) => node.textContent.trim() === 'Анна Петрова') && ${dataArrived('/home/base')}`,
  // Profile main data: the name, the balance block and a completed profile read. On this build the
  // preferences section is not always rendered (it depends on the profile's own capabilities), so the
  // marker uses the balance block that the self-profile read fills.
  profile: `document.querySelector('#profile-name') !== null && document.body.innerText.includes('Баланс') && ${dataArrived('/profile')}`,
  // The games catalog renders GAME items through GameCard (class "game-card").
  games: "document.querySelectorAll('.game-card').length > 0",
};
const PATHS = {
  home: '/',
  profile: '/profile',
  games: '/games',
  repeat: '/',
  profileNav: '/profile',
};

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
  ['read-job-start', /\/booking-screen-read-jobs$/],
  ['read-job-complete', /\/booking-screen-read-jobs\/[^/]+\/complete$/],
  ['read-job-poll', /\/booking-screen-read-jobs\/[^/]+$/],
  ['locations', /\/locations$/],
  ['communities-mine', /\/communities\/mine/],
  ['conversations', /\/conversations/],
  ['notifications', /\/notifications$/],
  ['notification-preferences', /\/notifications\/preferences/],
  ['public-games', /\/public\/api\/v1\/[^/]+\/games/],
];
const isApiUrl = (url) => /\/(?:user|public|admin)\/api\//.test(new URL(url).pathname);
function endpointOf(url) {
  const path = new URL(url).pathname;
  const match = ENDPOINTS.find(([, pattern]) => pattern.test(path));
  return match ? match[0] : isApiUrl(url) ? 'other-api' : 'static';
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
    return () => {
      this.handlers = this.handlers.filter((entry) => entry !== handler);
    };
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

async function collectRun(cdp, sinceMs = 0) {
  const stats = await stubStats();
  const navigation = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const nav = performance.getEntriesByType('navigation')[0];
      const resources = performance.getEntriesByType('resource')
        .filter((entry) => entry.startTime >= ${sinceMs})
        .map((entry) => ({
          name: entry.name,
          startTime: entry.startTime - ${sinceMs},
          responseEnd: entry.responseEnd - ${sinceMs},
          encodedBodySize: entry.encodedBodySize || 0,
          transferSize: entry.transferSize || 0,
        }));
      return {
        lcp: window.__PHUB_MARKS.lcp,
        domContentLoaded: nav ? nav.domContentLoadedEventEnd : 0,
        timeOrigin: performance.timeOrigin,
        resources,
      };
    })()`,
    returnByValue: true,
  });
  const pageText = debug
    ? (
        await cdp.send('Runtime.evaluate', {
          expression:
            "JSON.stringify({name: !!document.querySelector('#profile-name'), prefs: !!document.querySelector('.profile-booking-preferences'), balance: document.body.innerText.includes('Баланс'), text: document.body.innerText.slice(0, 200)})",
          returnByValue: true,
        })
      ).result.value
    : undefined;
  const resources = navigation.result.value.resources;
  const apiBytes = stats.requests.reduce((total, entry) => total + entry.bytes, 0);
  const apiRequestCount = stats.requests.reduce((total, entry) => total + entry.count, 0);
  const apiResources = resources.filter((entry) => isApiUrl(entry.name));
  const staticResources = resources.filter((entry) => !isApiUrl(entry.name));
  const sum = (entries, field) => entries.reduce((total, entry) => total + entry[field], 0);
  return {
    lcp: navigation.result.value.lcp,
    domContentLoaded: navigation.result.value.domContentLoaded,
    timeOrigin: navigation.result.value.timeOrigin,
    apiRequests: apiRequestCount,
    apiPayloadBytes: apiBytes,
    networkRequests: resources.length,
    networkTransferBytes: sum(resources, 'transferSize'),
    apiNetworkBytes: sum(apiResources, 'transferSize'),
    staticTransferBytes: sum(staticResources, 'transferSize'),
    endpointCounts: Object.fromEntries(
      stats.requests.map((entry) => [entry.endpoint, entry.count]),
    ),
    requestKeys: stats.requests.map((entry) => `${entry.key} ×${entry.count}`),
    waterfall: apiResources
      .map((entry) => ({
        endpoint: endpointOf(entry.name),
        startMs: Math.round(entry.startTime),
        endMs: Math.round(entry.responseEnd),
        bytes: entry.encodedBodySize,
      }))
      .sort((left, right) => left.startMs - right.startMs),
    ...(pageText ? { pageText } : {}),
  };
}

let runSequence = 0;

async function cssCoverageOf(cdp) {
  const { ruleUsage } = await cdp.send('CSS.stopRuleUsageTracking');
  const sheets = new Map();
  for (const rule of ruleUsage) {
    const entry = sheets.get(rule.styleSheetId) ?? { used: [], total: 0 };
    if (rule.used) entry.used.push([rule.startOffset, rule.endOffset]);
    sheets.set(rule.styleSheetId, entry);
  }
  let totalBytes = 0;
  let usedBytes = 0;
  for (const [styleSheetId, entry] of sheets) {
    try {
      const { text } = await cdp.send('CSS.getStyleSheetText', { styleSheetId });
      if (!text) continue;
      const merged = entry.used
        .sort((left, right) => left[0] - right[0])
        .reduce((ranges, [start, end]) => {
          const last = ranges[ranges.length - 1];
          if (last && start <= last[1]) last[1] = Math.max(last[1], end);
          else ranges.push([start, end]);
          return ranges;
        }, []);
      const used = merged.reduce((sum, [start, end]) => sum + (end - start), 0);
      totalBytes += text.length;
      usedBytes += used;
    } catch {
      // Some sheets (extensions, injected) cannot be read; they are not part of the measurement.
    }
  }
  return { totalBytes, usedBytes };
}

async function runColdScenario(cdp, scenario, options = {}) {
  const path = PATHS[scenario] ?? '/';
  const url = `${baseUrl}${path}`;
  const runId = `run-${++runSequence}`;
  if (!options.keepCache) await cdp.send('Network.clearBrowserCache');
  await cdp.send('Page.navigate', { url: 'about:blank' });
  await sleep(100);
  await stubReset();
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__PHUB_RUN_ID = '${runId}';${INSTRUMENT}`,
  });
  if (cssCoverage) await cdp.send('CSS.startRuleUsageTracking');
  let tracing = false;
  if (tracePath && scenario === 'home') {
    await cdp.send('Tracing.start', {
      traceConfig: { includedCategories: ['devtools.timeline', 'blink.user_timing', 'loading'] },
      transferMode: 'ReportEvents',
    });
    tracing = true;
  }

  const startedAt = Date.now();
  await cdp.send('Page.navigate', { url });
  const firstData = await waitForMarker(
    cdp,
    `window.__PHUB_RUN_ID === '${runId}' && (${MARKERS[scenario] ?? MARKERS.home})`,
  );
  let coverage;
  if (cssCoverage) coverage = await cssCoverageOf(cdp);
  if (tracing) {
    const events = [];
    const collect = cdp.onEvent((message) => {
      if (message.method === 'Tracing.dataCollected') events.push(...message.params.value);
    });
    await cdp.send('Tracing.end');
    await new Promise((resolve) => {
      const done = cdp.onEvent((message) => {
        if (message.method === 'Tracing.tracingComplete') {
          done();
          collect();
          resolve();
        }
      });
      setTimeout(() => {
        done();
        collect();
        resolve();
      }, 10000);
    });
    writeFileSync(tracePath, JSON.stringify({ traceEvents: events }));
  }
  const sample = await collectRun(cdp, 0);
  return {
    ...sample,
    scenario,
    firstDataMs: firstData,
    wallMs: Date.now() - startedAt,
    ...(coverage ? { cssCoverage: coverage } : {}),
  };
}

async function runNavigationScenario(cdp) {
  await runColdScenario(cdp, 'home');
  await stubReset();
  const runId = `nav-${++runSequence}`;
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__PHUB_RUN_ID = '${runId}';`,
  });
  const startedAt = Date.now();
  const navStart = await cdp.send('Runtime.evaluate', {
    expression:
      "window.__PHUB_NAV_START = performance.now(); window.history.pushState({}, '', '/profile'); window.dispatchEvent(new PopStateEvent('popstate')); window.__PHUB_NAV_START",
    returnByValue: true,
  });
  const firstData = await waitForMarker(cdp, MARKERS.profile);
  const sample = await collectRun(cdp, navStart.result.value);
  return {
    ...sample,
    scenario: 'profile-nav',
    firstDataMs: firstData,
    wallMs: Date.now() - startedAt,
  };
}

async function runBackgroundRefresh(cdp) {
  await runColdScenario(cdp, 'home');
  await stubReset();
  const startedAt = Date.now();
  let requestAt = null;
  const stop = (message) => {
    if (message.method !== 'Network.requestWillBeSent') return;
    if (!String(message.params?.request?.url ?? '').includes('/home/base')) return;
    requestAt = Date.now() - startedAt;
  };
  const unregister = cdp.onEvent(stop);
  await cdp.send('Runtime.evaluate', {
    expression:
      "window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); 1",
    returnByValue: true,
  });
  while (Date.now() - startedAt < 15000 && requestAt === null) await sleep(20);
  unregister();
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
    for (const request of sample.waterfall ?? []) {
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
  if (cssCoverage) {
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');
  }
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
      apiRequests: stats(samples.map((sample) => sample.apiRequests).filter((value) => value > 0)),
      apiPayloadBytes: stats(
        samples.map((sample) => sample.apiPayloadBytes).filter((value) => value > 0),
      ),
      networkTransferBytes: stats(
        samples.map((sample) => sample.networkTransferBytes).filter((value) => value > 0),
      ),
      staticTransferBytes: stats(
        samples.map((sample) => sample.staticTransferBytes).filter((value) => value > 0),
      ),
      cssCoverage: cssCoverage
        ? stats(
            samples
              .map((sample) => sample.cssCoverage?.usedBytes)
              .filter((value) => typeof value === 'number' && value > 0),
          )
        : undefined,
      cssCoverageTotalBytes: cssCoverage
        ? stats(
            samples
              .map((sample) => sample.cssCoverage?.totalBytes)
              .filter((value) => typeof value === 'number' && value > 0),
          )
        : undefined,
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
