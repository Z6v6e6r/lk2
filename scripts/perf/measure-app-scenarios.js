#!/usr/bin/env node
// LOCAL synthetic timing of LK2 screens against scripts/perf/stub-lk2-api.js.
//
// ONE CLOCK: every duration comes from the page's own performance timeline. For a document
// navigation the clock starts at its navigation start (performance entry startTime 0); for an in-app
// transition it starts at the user action mark captured in the page. Node wall clock is used only for
// run bookkeeping and is never mixed into a duration.
//
// RUN ISOLATION: each run opens a run epoch on the stub before navigation and freezes a snapshot
// after the marker. A request is attributed to the run that was open when it STARTED, so a late
// response stays with its own run and cannot change a frozen snapshot. The harness re-reads the
// frozen snapshot after a delay and records whether it stayed byte-identical.
//
// These are client timings against a synthetic API. They are NOT user measurements, NOT STAGING
// evidence and NOT a run of the installed Android application.
//
// Usage:
//   node scripts/perf/measure-app-scenarios.js --baseline=http://127.0.0.1:4181 \
//     --candidate=http://127.0.0.1:4180 --runs=7 --scenarios=home,profile,games,repeat,nav
//   node scripts/perf/measure-app-scenarios.js http://127.0.0.1:4180 --runs=3 --scenarios=home
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const raw = argv.find((value) => value.startsWith('--' + name + '='));
  return raw === undefined ? fallback : raw.slice(name.length + 3);
};
const has = (name) => argv.includes('--' + name);
const positional = argv.find((value) => !value.startsWith('--'));
const repetitions = Number(flag('runs', 7));
const scenarioList = flag('scenarios', 'home,profile,games,repeat,nav').split(',');
const throttle = !has('no-throttle');
const tracePath = flag('trace', undefined);
const chromePath =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const baselineUrl = flag('baseline', undefined);
const candidateUrl = flag('candidate', undefined);
const variants =
  baselineUrl && candidateUrl
    ? [
        { name: 'baseline', url: baselineUrl.replace(/\/$/, '') },
        { name: 'candidate', url: candidateUrl.replace(/\/$/, '') },
      ]
    : [
        {
          name: flag('label', 'candidate'),
          url: (positional ?? 'http://127.0.0.1:4180').replace(/\/$/, ''),
        },
      ];
const alternating = variants.length === 2;

// A required read is the data the marker must wait for. Optional enrichment is measured separately.
const SCENARIOS = {
  home: {
    path: '/',
    dom:
      "document.querySelector('.fh-bottom-nav') !== null && " +
      "Array.from(document.querySelectorAll('h1,h2')).some((node) => node.textContent.trim() === 'Анна Петрова')",
    required: ['/home/base'],
    recommendation:
      "document.querySelector('.booking-recommendation, .game-card') !== null || " +
      "document.querySelector('.booking-recommendations-empty') !== null",
  },
  profile: {
    path: '/profile',
    dom:
      "document.querySelector('#profile-name') !== null && " +
      "document.body.innerText.includes('Баланс')",
    required: ['/profile'],
    recommendation: 'false',
  },
  games: {
    path: '/games',
    dom: "document.querySelectorAll('.game-card').length > 0",
    required: ['/booking-screen-read-jobs', '/complete'],
    recommendation: "document.querySelectorAll('.game-card').length > 0",
  },
  repeat: {
    path: '/',
    warm: 'home',
    dom:
      "document.querySelector('.fh-bottom-nav') !== null && " +
      "Array.from(document.querySelectorAll('h1,h2')).some((node) => node.textContent.trim() === 'Анна Петрова')",
    required: ['/home/base'],
  },
  nav: {
    // Home is loaded first, then an in-app transition to Games, whose cards need a data read. The
    // clock starts at the user action, so this measures a data-bearing transition, not a cached one.
    path: '/',
    warm: 'home',
    spaPath: '/games',
    dom: "document.querySelectorAll('.game-card').length > 0",
    required: ['/complete'],
  },
};

const RESOURCE_GROUPS = [
  ['api', (url) => /\/(?:user|public|admin)\/api\//.test(new URL(url).pathname)],
  ['js', (url) => new URL(url).pathname.endsWith('.js')],
  ['css', (url) => new URL(url).pathname.endsWith('.css')],
  ['font', (url) => /\.(woff2?|ttf|otf)$/.test(new URL(url).pathname)],
  ['image', (url) => /\.(png|jpe?g|webp|gif|svg)$/.test(new URL(url).pathname)],
];

function groupOf(url) {
  const match = RESOURCE_GROUPS.find(([, test]) => test(url));
  return match ? match[0] : 'other';
}

function httpJson(url, method = 'GET', body) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const request = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
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
          try {
            resolve({ status: response.statusCode, body: raw ? JSON.parse(raw) : undefined, raw });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.on('error', reject);
    request.setTimeout(10000, () => request.destroy(new Error('stub control timeout')));
    if (payload) request.write(payload);
    request.end();
  });
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
      '--user-data-dir=' + profileDir,
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
        if (this.pending.delete(id)) reject(new Error('CDP timeout: ' + method));
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

const INSTRUMENT =
  '(() => {' +
  'window.__PHUB_MARKS = { lcp: 0 };' +
  'window.__PHUB_ERRORS = [];' +
  "window.addEventListener('error', (event) => window.__PHUB_ERRORS.push(String(event.message)));" +
  "window.addEventListener('unhandledrejection', (event) => window.__PHUB_ERRORS.push(String(event.reason)));" +
  'try { new PerformanceObserver((list) => { const entries = list.getEntries(); if (entries.length) window.__PHUB_MARKS.lcp = entries[entries.length - 1].startTime; }).observe({ type: "largest-contentful-paint", buffered: true }); } catch (error) {}' +
  '})();';

const PAGE_STATE =
  '(() => {' +
  'const navigation = performance.getEntriesByType("navigation")[0];' +
  'const resources = performance.getEntriesByType("resource").map((entry) => ({' +
  '  name: entry.name, startTime: entry.startTime, responseEnd: entry.responseEnd,' +
  '  initiatorType: entry.initiatorType, transferSize: entry.transferSize || 0,' +
  '  encodedBodySize: entry.encodedBodySize || 0, decodedBodySize: entry.decodedBodySize || 0' +
  '}));' +
  'return {' +
  '  timeOrigin: performance.timeOrigin,' +
  '  navigationStart: navigation ? navigation.startTime : 0,' +
  '  domContentLoaded: navigation ? navigation.domContentLoadedEventEnd : null,' +
  '  loadEvent: navigation ? navigation.loadEventEnd : null,' +
  '  lcp: window.__PHUB_MARKS ? window.__PHUB_MARKS.lcp : null,' +
  '  mark: window.__PHUB_MARK ?? null,' +
  '  errors: window.__PHUB_ERRORS ?? [],' +
  '  resources' +
  '};' +
  '})()';

function markerExpression(runId, scenario) {
  const config = SCENARIOS[scenario];
  return (
    '(() => {' +
    'if (window.__PHUB_RUN_ID !== "' +
    runId +
    '") return { ok: false, reason: "stale-document" };' +
    'const dom = (' +
    config.dom +
    ');' +
    'if (!dom) return { ok: false };' +
    'if (!window.__PHUB_MARK) {' +
    '  window.__PHUB_MARK = {' +
    '    domAt: performance.now(),' +
    '    displayedAt: null,' +
    '    recommendationVisible: Boolean(' +
    (config.recommendation ?? 'false') +
    ')' +
    '  };' +
    '  requestAnimationFrame(() => requestAnimationFrame(() => {' +
    '    window.__PHUB_MARK.displayedAt = performance.now();' +
    '    window.__PHUB_MARK.lcpAfterDisplay = window.__PHUB_MARKS ? window.__PHUB_MARKS.lcp : null;' +
    '  }));' +
    '}' +
    'return {' +
    '  ok: window.__PHUB_MARK.displayedAt !== null,' +
    '  mark: window.__PHUB_MARK,' +
    '  errors: window.__PHUB_ERRORS ?? [],' +
    '  navStart: window.__PHUB_NAV_START ?? 0' +
    '};' +
    '})()'
  );
}

async function waitForMarker(cdp, runId, scenario, timeoutMs = 25000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    const result = await cdp.send('Runtime.evaluate', {
      expression: markerExpression(runId, scenario),
      returnByValue: true,
    });
    last = result.result.value;
    if (last && last.errors && last.errors.length > 0) {
      return {
        timeout: false,
        pageErrors: last.errors,
        mark: last.mark ?? null,
        navStart: last.navStart ?? 0,
      };
    }
    if (last && last.ok) {
      return { timeout: false, mark: last.mark, navStart: last.navStart ?? 0, pageErrors: [] };
    }
    await sleep(20);
  }
  return {
    timeout: true,
    mark: last?.mark ?? null,
    navStart: last?.navStart ?? 0,
    pageErrors: last?.errors ?? [],
  };
}

async function pageState(cdp) {
  const result = await cdp.send('Runtime.evaluate', {
    expression: PAGE_STATE,
    returnByValue: true,
  });
  return result.result.value;
}

async function beginRun(url, label) {
  const response = await httpJson(url + '/__perf/run/begin', 'POST', { label });
  return response.body.runId;
}

async function endRun(url, runId) {
  const response = await httpJson(
    url + '/__perf/run/' + encodeURIComponent(runId) + '/end',
    'POST',
  );
  return response;
}

async function readRun(url, runId) {
  const response = await httpJson(url + '/__perf/run/' + encodeURIComponent(runId));
  return response;
}

function resourcesSince(resources, sinceMs) {
  return resources
    .filter((entry) => entry.startTime >= sinceMs)
    .map((entry) => ({
      ...entry,
      startMs: entry.startTime - sinceMs,
      endMs: entry.responseEnd - sinceMs,
      group: groupOf(entry.name),
    }));
}

function groupStats(resources, group) {
  const entries = resources.filter((entry) => entry.group === group);
  return {
    count: entries.length,
    transferBytes: entries.reduce((total, entry) => total + entry.transferSize, 0),
    encodedBytes: entries.reduce((total, entry) => total + entry.encodedBodySize, 0),
  };
}

function requiredEndMs(resources, requiredPaths) {
  const matching = resources.filter(
    (entry) =>
      entry.group === 'api' &&
      requiredPaths.some((fragment) => new URL(entry.name).pathname.endsWith(fragment)),
  );
  if (matching.length === 0) return null;
  return Math.max(...matching.map((entry) => entry.endMs));
}

function percentileFree(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
  return {
    runs: sorted.length,
    medianMs: Math.round(median),
    minMs: Math.round(sorted[0]),
    maxMs: Math.round(sorted[sorted.length - 1]),
    valuesMs: sorted.map((value) => Math.round(value)),
  };
}

function bytesStats(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
  return {
    runs: sorted.length,
    medianBytes: Math.round(median),
    minBytes: sorted[0],
    maxBytes: sorted[sorted.length - 1],
  };
}

async function captureTrace(cdp, file) {
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
  writeFileSync(file, JSON.stringify({ traceEvents: events }));
}

async function cssCoverage(cdp) {
  const { ruleUsage } = await cdp.send('CSS.stopRuleUsageTracking');
  const sheets = new Map();
  for (const rule of ruleUsage) {
    const entry = sheets.get(rule.styleSheetId) ?? { used: [] };
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
      totalBytes += text.length;
      usedBytes += merged.reduce((sum, [start, end]) => sum + (end - start), 0);
    } catch (error) {
      // Injected or inaccessible sheets are not part of the measurement.
    }
  }
  return { totalBytes, usedBytes };
}

let runSequence = 0;

async function measureOne(cdp, variant, scenario, options) {
  const config = SCENARIOS[scenario];
  const runLabel = variant.name + ':' + scenario + ':' + String(options.rep);
  const runId = await beginRun(variant.url, runLabel).catch(() => undefined);
  if (!runId) {
    return {
      variant: variant.name,
      scenario,
      rep: options.rep,
      valid: false,
      exclusionReason: 'stub-begin-failed',
    };
  }
  const documentRunId = 'doc-' + variant.name + '-' + String(++runSequence);
  if (!options.keepCache) await cdp.send('Network.clearBrowserCache');
  await cdp.send('Page.navigate', { url: 'about:blank' });
  await sleep(80);
  if (options.css) await cdp.send('CSS.startRuleUsageTracking');
  const tracing = Boolean(tracePath) && scenario === 'home';
  if (tracing) {
    await cdp.send('Tracing.start', {
      traceConfig: { includedCategories: ['devtools.timeline', 'blink.user_timing', 'loading'] },
      transferMode: 'ReportEvents',
    });
  }
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source:
      'window.__PHUB_RUN_ID = "' +
      documentRunId +
      '";' +
      'window.__PHUB_MARK = null;' +
      'window.__PHUB_NAV_START = 0;' +
      INSTRUMENT,
  });

  const navigationStartedAt = Date.now();
  await cdp.send('Page.navigate', { url: variant.url + config.path });
  const marker = await waitForMarker(cdp, documentRunId, scenario);
  const snapshot = await endRun(variant.url, runId).catch(() => undefined);

  let coverage;
  if (options.css) coverage = await cssCoverage(cdp);
  if (tracing) await captureTrace(cdp, tracePath);

  const state = await pageState(cdp);
  const sinceMs = marker.navStart ?? 0;
  const resources = resourcesSince(state.resources, sinceMs);
  const dataAppliedMs = requiredEndMs(resources, config.required);
  const displayedMs = marker.mark?.displayedAt != null ? marker.mark.displayedAt - sinceMs : null;
  const domAtMs = marker.mark?.domAt != null ? marker.mark.domAt - sinceMs : null;
  const refresh = resources.find((entry) => entry.name.endsWith('/auth/session/refresh'));
  const apiResources = resources.filter((entry) => entry.group === 'api');
  const firstApiMs =
    apiResources.length > 0 ? Math.min(...apiResources.map((entry) => entry.startMs)) : null;
  const lastApiMs =
    apiResources.length > 0 ? Math.max(...apiResources.map((entry) => entry.endMs)) : null;

  const frozenRaw = snapshot && snapshot.raw ? snapshot.raw : null;
  await sleep(200);
  const again = await readRun(variant.url, runId).catch(() => undefined);
  const snapshotStable = Boolean(frozenRaw && again && again.raw === frozenRaw);
  const frozen = snapshot?.body;

  const exclusions = [];
  if (marker.timeout) exclusions.push('marker-timeout');
  if (marker.pageErrors && marker.pageErrors.length > 0) exclusions.push('page-error');
  if (displayedMs === null) exclusions.push('no-display-time');
  if (dataAppliedMs === null) exclusions.push('required-read-not-observed');
  if (displayedMs !== null && dataAppliedMs !== null && displayedMs < dataAppliedMs - 5) {
    exclusions.push('displayed-before-data');
  }
  if (!frozen) exclusions.push('no-run-snapshot');
  if (!snapshotStable && frozen) exclusions.push('snapshot-not-stable');

  const group = (name) => groupStats(resources, name);
  const sample = {
    variant: variant.name,
    scenario,
    rep: options.rep,
    runId,
    label: runLabel,
    documentRunId,
    valid: exclusions.length === 0,
    exclusionReason: exclusions.join(',') || null,
    wallClockStartedAt: navigationStartedAt,
    timeOrigin: state.timeOrigin,
    sinceMs,
    marker: {
      domAtMs: domAtMs === null ? null : Math.round(domAtMs),
      displayedMs: displayedMs === null ? null : Math.round(displayedMs),
      recommendationVisible: Boolean(marker.mark?.recommendationVisible),
      source: options.sinceSource ?? 'document-navigation-start',
    },
    timings: {
      sessionRestoreMs: refresh ? Math.round(refresh.endMs) : null,
      firstApiRequestMs: firstApiMs === null ? null : Math.round(firstApiMs),
      requiredDataAppliedMs: dataAppliedMs === null ? null : Math.round(dataAppliedMs),
      lastApiResponseMs: lastApiMs === null ? null : Math.round(lastApiMs),
      renderAfterDataMs:
        displayedMs !== null && dataAppliedMs !== null
          ? Math.round(displayedMs - dataAppliedMs)
          : null,
      enrichmentAfterRequiredMs:
        lastApiMs !== null && dataAppliedMs !== null ? Math.round(lastApiMs - dataAppliedMs) : null,
    },
    network: {
      total:
        group('api').transferBytes +
        group('js').transferBytes +
        group('css').transferBytes +
        group('font').transferBytes +
        group('image').transferBytes +
        group('other').transferBytes,
      api: group('api'),
      js: group('js'),
      css: group('css'),
      font: group('font'),
      image: group('image'),
      other: group('other'),
      source: 'PerformanceResourceTiming.transferSize (headers included), same page clock',
    },
    api: frozen
      ? {
          requests: frozen.aggregates.requests,
          completed: frozen.aggregates.completed,
          inFlight: frozen.aggregates.inFlight,
          payloadBytes: frozen.aggregates.bytes,
          byEndpoint: frozen.aggregates.byEndpoint,
          statuses: Object.fromEntries(
            Object.values(frozen.aggregates.byEndpoint).flatMap((entry) =>
              Object.entries(entry.statuses ?? {}),
            ),
          ),
          lateCompletions: frozen.lateCompletions,
          snapshotStable,
        }
      : null,
    pageErrors: marker.pageErrors ?? state.errors ?? [],
    ...(coverage ? { cssCoverage: coverage } : {}),
    resources,
  };
  return sample;
}

async function measureNavigation(cdp, variant, scenario, options) {
  const config = SCENARIOS[scenario];
  // Every nav run starts from the same cache state: clear, load Home (unmeasured), then act.
  await cdp.send('Network.clearBrowserCache');
  await measureOne(cdp, variant, 'home', {
    ...options,
    rep: options.rep,
    keepCache: true,
    warmOnly: true,
  });
  // The action happens after the warm Home has been displayed for a moment, which is also the window
  // the idle screen prefetch uses; a tap before that window is reported as such in the docs.
  await sleep(1000);
  const runLabel = variant.name + ':' + scenario + ':' + String(options.rep);
  const runId = await beginRun(variant.url, runLabel).catch(() => undefined);
  const documentRunId = 'same-document';
  const action = await cdp.send('Runtime.evaluate', {
    expression:
      'window.__PHUB_NAV_START = performance.now();' +
      'window.__PHUB_MARK = null;' +
      'window.__PHUB_RUN_ID = "' +
      documentRunId +
      '";' +
      'window.history.pushState({}, "", "' +
      config.spaPath +
      '");' +
      'window.dispatchEvent(new PopStateEvent("popstate"));' +
      'window.__PHUB_NAV_START',
    returnByValue: true,
  });
  const actionAt = action.result.value;
  const marker = await waitForMarker(cdp, documentRunId, scenario);
  const snapshot = runId ? await endRun(variant.url, runId).catch(() => undefined) : undefined;
  const state = await pageState(cdp);
  const resources = resourcesSince(state.resources, actionAt);
  const dataAppliedMs = requiredEndMs(resources, config.required);
  const displayedMs = marker.mark?.displayedAt != null ? marker.mark.displayedAt - actionAt : null;
  const domAtMs = marker.mark?.domAt != null ? marker.mark.domAt - actionAt : null;
  const frozen = snapshot?.body;
  const frozenRaw = snapshot?.raw ?? null;
  await sleep(200);
  const again = runId ? await readRun(variant.url, runId).catch(() => undefined) : undefined;
  const snapshotStable = Boolean(frozenRaw && again && again.raw === frozenRaw);
  const exclusions = [];
  if (!runId) exclusions.push('stub-begin-failed');
  if (marker.timeout) exclusions.push('marker-timeout');
  if (marker.pageErrors && marker.pageErrors.length > 0) exclusions.push('page-error');
  if (displayedMs === null) exclusions.push('no-display-time');
  if (dataAppliedMs === null) exclusions.push('required-read-not-observed');
  if (displayedMs !== null && dataAppliedMs !== null && displayedMs < dataAppliedMs - 5)
    exclusions.push('displayed-before-data');
  if (!frozen) exclusions.push('no-run-snapshot');
  if (!snapshotStable && frozen) exclusions.push('snapshot-not-stable');
  return {
    variant: variant.name,
    scenario,
    rep: options.rep,
    runId,
    label: runLabel,
    documentRunId,
    valid: exclusions.length === 0,
    exclusionReason: exclusions.join(',') || null,
    wallClockStartedAt: Date.now(),
    timeOrigin: state.timeOrigin,
    sinceMs: actionAt,
    marker: {
      domAtMs: domAtMs === null ? null : Math.round(domAtMs),
      displayedMs: displayedMs === null ? null : Math.round(displayedMs),
      recommendationVisible: Boolean(marker.mark?.recommendationVisible),
      source: 'in-app-action-mark',
    },
    timings: {
      sessionRestoreMs: null,
      firstApiRequestMs: resources.filter((entry) => entry.group === 'api').length
        ? Math.round(
            Math.min(
              ...resources.filter((entry) => entry.group === 'api').map((entry) => entry.startMs),
            ),
          )
        : null,
      requiredDataAppliedMs: dataAppliedMs === null ? null : Math.round(dataAppliedMs),
      lastApiResponseMs: resources.filter((entry) => entry.group === 'api').length
        ? Math.round(
            Math.max(
              ...resources.filter((entry) => entry.group === 'api').map((entry) => entry.endMs),
            ),
          )
        : null,
      renderAfterDataMs:
        displayedMs !== null && dataAppliedMs !== null
          ? Math.round(displayedMs - dataAppliedMs)
          : null,
      enrichmentAfterRequiredMs: null,
    },
    network: {
      total:
        groupStats(resources, 'api').transferBytes +
        groupStats(resources, 'js').transferBytes +
        groupStats(resources, 'css').transferBytes +
        groupStats(resources, 'font').transferBytes +
        groupStats(resources, 'image').transferBytes +
        groupStats(resources, 'other').transferBytes,
      api: groupStats(resources, 'api'),
      js: groupStats(resources, 'js'),
      css: groupStats(resources, 'css'),
      font: groupStats(resources, 'font'),
      image: groupStats(resources, 'image'),
      other: groupStats(resources, 'other'),
      source: 'PerformanceResourceTiming.transferSize (headers included)',
    },
    api: frozen
      ? {
          requests: frozen.aggregates.requests,
          completed: frozen.aggregates.completed,
          inFlight: frozen.aggregates.inFlight,
          payloadBytes: frozen.aggregates.bytes,
          byEndpoint: frozen.aggregates.byEndpoint,
          lateCompletions: frozen.lateCompletions,
          snapshotStable,
        }
      : null,
    pageErrors: marker.pageErrors ?? state.errors ?? [],
    resources,
  };
}

async function measureBackground(cdp, variant, options) {
  await measureOne(cdp, variant, 'home', { ...options, keepCache: true });
  const runId = await beginRun(variant.url, variant.name + ':background:' + String(options.rep));
  const focus = await cdp.send('Runtime.evaluate', {
    expression:
      'window.__PHUB_FOCUS_AT = performance.now();' +
      "window.dispatchEvent(new Event('focus'));" +
      "document.dispatchEvent(new Event('visibilitychange'));" +
      'window.__PHUB_FOCUS_AT',
    returnByValue: true,
  });
  const focusAt = focus.result.value;
  let refreshMs = null;
  const started = Date.now();
  while (Date.now() - started < 10000 && refreshMs === null) {
    const state = await pageState(cdp);
    const entry = state.resources
      .filter((resource) => resource.name.endsWith('/home/base') && resource.startTime >= focusAt)
      .sort((left, right) => left.startTime - right.startTime)[0];
    if (entry) refreshMs = Math.round(entry.startTime - focusAt);
    else await sleep(20);
  }
  const snapshot = runId ? await endRun(variant.url, runId) : undefined;
  return {
    variant: variant.name,
    scenario: 'background',
    rep: options.rep,
    runId,
    valid: refreshMs !== null && Boolean(snapshot?.body),
    exclusionReason: refreshMs === null ? 'no-refresh-request' : null,
    focusAt,
    refreshRequestMs: refreshMs,
    api: snapshot?.body
      ? {
          requests: snapshot.body.aggregates.requests,
          payloadBytes: snapshot.body.aggregates.bytes,
          byEndpoint: snapshot.body.aggregates.byEndpoint,
        }
      : null,
  };
}

const profileDir = mkdtempSync(join(tmpdir(), 'phub-scenario-'));
const chrome = launchChrome(profileDir);
let socket;
try {
  const port = await waitForPort(profileDir);
  const targets = await fetch('http://127.0.0.1:' + port + '/json/list').then((response) =>
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
  const cssEnabled = has('css-coverage');
  if (cssEnabled) {
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');
  }
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: Number(flag('width', 412)),
    height: Number(flag('height', 915)),
    deviceScaleFactor: 2.625,
    mobile: true,
  });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: Number(flag('cpu', 4)) });
  if (throttle) {
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 150,
      downloadThroughput: (1.6 * 1024 * 1024) / 8,
      uploadThroughput: (750 * 1024) / 8,
      connectionType: 'cellular4g',
    });
  }
  const browserVersion = await cdp.send('Browser.getVersion').catch(() => undefined);
  const stubMeta = {};
  for (const variant of variants) {
    stubMeta[variant.name] = (
      await httpJson(variant.url + '/__perf/meta').catch(() => undefined)
    )?.body;
  }

  const attempts = [];
  const record = (attempt) => {
    attempts.push(attempt);
    const status = attempt.valid ? 'valid' : 'EXCLUDED:' + attempt.exclusionReason;
    // Progress lines go to stderr so stdout stays a single JSON document.
    console.error(
      attempt.variant +
        ' ' +
        attempt.scenario +
        ' rep' +
        String(attempt.rep) +
        ' ' +
        status +
        ' displayed=' +
        String(attempt.marker?.displayedMs ?? '-') +
        ' applied=' +
        String(attempt.timings?.requiredDataAppliedMs ?? '-'),
    );
    return attempt;
  };

  for (let rep = 1; rep <= repetitions; rep += 1) {
    const order = alternating ? (rep % 2 === 1 ? [0, 1] : [1, 0]) : [0];
    for (const variantIndex of order) {
      const variant = variants[variantIndex];
      for (const scenario of scenarioList) {
        try {
          if (scenario === 'nav') {
            record(await measureNavigation(cdp, variant, 'nav', { rep }));
            continue;
          }
          if (scenario === 'background') {
            record(await measureBackground(cdp, variant, { rep }));
            continue;
          }
          if (scenario === 'repeat') {
            // Identical warm-up for both variants: one full Home load with a cold cache, then the
            // measured repeat open with the cache kept.
            await measureOne(cdp, variant, 'home', { rep: rep, keepCache: false });
            record(
              await measureOne(cdp, variant, 'repeat', {
                rep: rep,
                keepCache: true,
                css: cssEnabled,
                trace: false,
              }),
            );
            continue;
          }
          record(
            await measureOne(cdp, variant, scenario, {
              rep: rep,
              keepCache: false,
              css:
                cssEnabled &&
                (scenario === 'home' || scenario === 'profile' || scenario === 'games'),
            }),
          );
        } catch (error) {
          record({
            variant: variant.name,
            scenario,
            rep,
            valid: false,
            exclusionReason:
              'harness-error:' + String(error && error.message ? error.message : error),
          });
        }
      }
    }
  }

  const metricNames = [
    'displayedMs',
    'domAtMs',
    'requiredDataAppliedMs',
    'sessionRestoreMs',
    'firstApiRequestMs',
    'lastApiResponseMs',
    'renderAfterDataMs',
    'enrichmentAfterRequiredMs',
    'refreshRequestMs',
  ];
  const aggregate = (samples) => {
    const out = { runs: samples.length };
    for (const name of metricNames) {
      const values = samples
        .map((sample) =>
          name === 'refreshRequestMs'
            ? sample.refreshRequestMs
            : (sample.marker?.[name] ?? sample.timings?.[name]),
        )
        .filter((value) => typeof value === 'number' && !Number.isNaN(value));
      if (values.length === 0) continue;
      const sorted = [...values].sort((left, right) => left - right);
      const middle = Math.floor(sorted.length / 2);
      const median =
        sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
      out[name] = {
        runs: sorted.length,
        median: Math.round(median),
        min: Math.round(sorted[0]),
        max: Math.round(sorted[sorted.length - 1]),
        values: sorted.map((value) => Math.round(value)),
      };
    }
    const payloadBytes = samples
      .map((sample) => sample.api?.payloadBytes)
      .filter((value) => typeof value === 'number');
    if (payloadBytes.length > 0) {
      const sorted = [...payloadBytes].sort((left, right) => left - right);
      const middle = Math.floor(sorted.length / 2);
      out.apiPayloadBytes = {
        runs: sorted.length,
        median:
          sorted.length % 2 === 0
            ? Math.round((sorted[middle - 1] + sorted[middle]) / 2)
            : sorted[middle],
        min: sorted[0],
        max: sorted[sorted.length - 1],
      };
    }
    const apiRequests = samples
      .map((sample) => sample.api?.requests)
      .filter((value) => typeof value === 'number');
    if (apiRequests.length > 0) {
      const sorted = [...apiRequests].sort((left, right) => left - right);
      const middle = Math.floor(sorted.length / 2);
      out.apiRequests = {
        runs: sorted.length,
        median:
          sorted.length % 2 === 0
            ? Math.round((sorted[middle - 1] + sorted[middle]) / 2)
            : sorted[middle],
        min: sorted[0],
        max: sorted[sorted.length - 1],
      };
    }
    const network = {};
    for (const group of ['total', 'api', 'js', 'css', 'font', 'image', 'other']) {
      const values = samples
        .map((sample) =>
          group === 'total' ? sample.network?.total : sample.network?.[group]?.transferBytes,
        )
        .filter((value) => typeof value === 'number');
      if (values.length === 0) continue;
      const sorted = [...values].sort((left, right) => left - right);
      const middle = Math.floor(sorted.length / 2);
      network[group] = {
        runs: sorted.length,
        median:
          sorted.length % 2 === 0
            ? Math.round((sorted[middle - 1] + sorted[middle]) / 2)
            : sorted[middle],
        min: sorted[0],
        max: sorted[sorted.length - 1],
      };
    }
    out.networkBytes = network;
    const css = samples.map((sample) => sample.cssCoverage).filter(Boolean);
    if (css.length > 0) {
      out.cssCoverage = {
        runs: css.length,
        medianUsedBytes: css.map((entry) => entry.usedBytes).sort((a, b) => a - b)[
          Math.floor(css.length / 2)
        ],
        medianTotalBytes: css.map((entry) => entry.totalBytes).sort((a, b) => a - b)[
          Math.floor(css.length / 2)
        ],
      };
    }
    return out;
  };

  const series = {};
  for (const variant of variants) {
    series[variant.name] = {};
    for (const scenario of scenarioList) {
      const all = attempts.filter(
        (attempt) => attempt.variant === variant.name && attempt.scenario === scenario,
      );
      series[variant.name][scenario] = {
        validRuns: all.filter((attempt) => attempt.valid).length,
        attempts: all.length,
        excluded: all
          .filter((attempt) => !attempt.valid)
          .map((attempt) => ({
            rep: attempt.rep,
            reason: attempt.exclusionReason,
            displayedMs: attempt.marker?.displayedMs ?? null,
          })),
        stats: aggregate(all.filter((attempt) => attempt.valid)),
      };
    }
  }

  const deltas = {};
  if (alternating) {
    for (const scenario of scenarioList) {
      const base = series.baseline?.[scenario]?.stats ?? {};
      const candidate = series.candidate?.[scenario]?.stats ?? {};
      const delta = (left, right) =>
        typeof left === 'number' && typeof right === 'number'
          ? {
              absolute: right - left,
              relativePercent: left === 0 ? null : Math.round(((right - left) / left) * 1000) / 10,
            }
          : null;
      deltas[scenario] = {
        displayedMs: delta(base.displayedMs?.median, candidate.displayedMs?.median),
        requiredDataAppliedMs: delta(
          base.requiredDataAppliedMs?.median,
          candidate.requiredDataAppliedMs?.median,
        ),
        apiPayloadBytes: delta(base.apiPayloadBytes?.median, candidate.apiPayloadBytes?.median),
        networkBytesTotal: delta(
          base.networkBytes?.total?.median,
          candidate.networkBytes?.total?.median,
        ),
      };
    }
  }

  const chronologies = attempts
    .filter((attempt) => attempt.marker && attempt.timings)
    .map((attempt) => ({
      variant: attempt.variant,
      scenario: attempt.scenario,
      rep: attempt.rep,
      domAtMs: attempt.marker.domAtMs,
      requiredDataAppliedMs: attempt.timings.requiredDataAppliedMs,
      displayedMs: attempt.marker.displayedMs,
      renderAfterDataMs: attempt.timings.renderAfterDataMs,
      valid: attempt.valid,
      reason: attempt.exclusionReason,
    }));

  console.log(
    JSON.stringify(
      {
        harness: 'scenario-stand-2026-11-18',
        generatedAt: new Date().toISOString(),
        clock: {
          rule: 'all durations come from the page performance timeline; Node wall clock only for run bookkeeping',
          documentNavigationOrigin: 'performance entry startTime 0',
          inAppTransitionOrigin: 'window.__PHUB_NAV_START captured at the user action',
        },
        environment: {
          chrome: browserVersion?.product ?? 'unknown',
          viewport: { width: Number(flag('width', 412)), height: Number(flag('height', 915)) },
          cpuThrottle: Number(flag('cpu', 4)),
          network: throttle ? '1.6Mbps down / 750kbps up, 150ms RTT' : 'unthrottled',
          repetitions,
          scenarios: scenarioList,
          alternating,
          variants: variants.map((variant) => ({ name: variant.name, url: variant.url })),
          stub: stubMeta,
        },
        series,
        deltas,
        chronologies,
        attempts,
      },
      null,
      2,
    ),
  );
} finally {
  try {
    socket?.close();
  } catch (error) {}
  chrome.kill('SIGKILL');
  try {
    rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (error) {}
}
