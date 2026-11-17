#!/usr/bin/env node
// LOCAL, synthetic measurement of the LK2 web shell on a throttled link.
//
// It drives a real Chrome (headless) over the DevTools protocol against the built `apps/web/dist`
// served by `vite preview`. Nothing here talks to a PadlHub API, so the numbers describe the
// client shell only: bundle transfer, script execution and the first rendered auth screen.
// They are NOT user measurements and must be reported as LOCAL evidence.
//
// Usage: node scripts/perf/measure-web-first-screen.mjs <url> [--runs=5] [--no-throttle]
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const url = process.argv[2] ?? 'http://127.0.0.1:4173/';
const runsArg = process.argv.find((arg) => arg.startsWith('--runs='));
const runs = runsArg ? Number(runsArg.split('=')[1]) : 5;
const throttle = !process.argv.includes('--no-throttle');
// `--cold-every-run` clears the HTTP cache before every navigation, so every sample is a first
// visit. Without it the first run is cold and the rest reuse the cache (a repeat app open).
const coldEveryRun = process.argv.includes('--cold-every-run');
const chromePath =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function launchChrome(profileDir) {
  return spawn(
    chromePath,
    [
      '--headless=new',
      // macOS agent sandboxes deny Chrome's own sandbox; the harness only loads the local build.
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
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.socket.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP timeout: ${method}`));
      }, 30000);
    });
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
  const isUseful = () => {
    if (document.querySelector('#auth-title, #yandex-login-title')) return 'auth';
    if (document.querySelector('[data-phub-home]')) return 'home';
    const loading = document.querySelector('.app-shell-loading, .mobile-status');
    return loading ? null : null;
  };
  const observer = new MutationObserver(() => {
    if (window.__PHUB_FIRST_SCREEN) return;
    const screen = isUseful();
    if (screen) {
      window.__PHUB_FIRST_SCREEN = { screen, at: performance.now() };
      observer.disconnect();
    }
  });
  // The observer can start before <html> exists, so it watches the document node itself.
  observer.observe(document, { childList: true, subtree: true });
  window.__PHUB_FIRST_SCREEN = null;
})();`;

async function runOnce(cdp, sessionId, warm) {
  // A cold visit starts from an empty HTTP cache; a warm visit keeps whatever the previous
  // navigation stored, which is what a repeat app open looks like.
  if (!warm) await cdp.send('Network.clearBrowserCache', {}, sessionId);
  await cdp.send('Page.navigate', { url: 'about:blank' }, sessionId);
  await sleep(120);
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: INSTRUMENT }, sessionId);
  const started = Date.now();
  await cdp.send('Page.navigate', { url }, sessionId);
  let firstScreen = null;
  while (Date.now() - started < 20000) {
    const result = await cdp.send(
      'Runtime.evaluate',
      { expression: 'window.__PHUB_FIRST_SCREEN ?? null', returnByValue: true },
      sessionId,
    );
    if (result.result.value) {
      firstScreen = result.result.value;
      break;
    }
    await sleep(25);
  }
  const metrics = await cdp.send(
    'Runtime.evaluate',
    {
      expression: `(() => {
        const nav = performance.getEntriesByType('navigation')[0];
        const resources = performance.getEntriesByType('resource');
        const scriptBytes = resources
          .filter((entry) => entry.initiatorType === 'script')
          .reduce((total, entry) => total + (entry.encodedBodySize || 0), 0);
        const styleBytes = resources
          .filter((entry) => entry.initiatorType === 'link' || entry.initiatorType === 'css')
          .reduce((total, entry) => total + (entry.encodedBodySize || 0), 0);
        return {
          firstScreen: window.__PHUB_FIRST_SCREEN,
          lcp: window.__PHUB_MARKS.lcp,
          domContentLoaded: nav ? nav.domContentLoadedEventEnd : 0,
          loadEvent: nav ? nav.loadEventEnd : 0,
          resources: resources.length,
          transferBytes: resources.reduce((total, entry) => total + (entry.encodedBodySize || 0), 0),
          scriptBytes,
          styleBytes,
        };
      })()`,
      returnByValue: true,
    },
    sessionId,
  );
  return { warm, wallMs: Date.now() - started, ...metrics.result.value };
}

function stats(values) {
  if (!values.length) return { runs: 0, p50: 0, p95: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return { runs: values.length, p50: Math.round(at(0.5)), p95: Math.round(at(0.95)) };
}

const profileDir = mkdtempSync(join(tmpdir(), 'phub-perf-'));
const chrome = launchChrome(profileDir);
let socket;
try {
  const port = await waitForPort(profileDir);
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
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

  const samples = [];
  for (let i = 0; i < runs; i += 1) {
    // Cache disabled in the browser process would simulate a first visit; warm runs reuse the
    // on-disk HTTP cache created by the previous navigation.
    samples.push(await runOnce(cdp, undefined, coldEveryRun ? false : i > 0));
  }

  const cold = coldEveryRun ? samples : samples.slice(0, 1);
  const warm = coldEveryRun ? [] : samples.slice(1);
  const summarize = (list) => ({
    runs: list.length,
    firstScreenMs: stats(list.filter((s) => s.firstScreen).map((s) => s.firstScreen.at)),
    lcpMs: stats(list.filter((s) => s.lcp).map((s) => s.lcp)),
    domContentLoadedMs: stats(list.map((s) => s.domContentLoaded)),
    requests: stats(list.map((s) => s.resources)),
    transferBytes: stats(list.map((s) => s.transferBytes)),
    scriptBytes: stats(list.map((s) => s.scriptBytes)),
    styleBytes: stats(list.map((s) => s.styleBytes)),
  });

  console.log(
    JSON.stringify(
      {
        url,
        mode: throttle ? '4G 1.6Mbps/150ms RTT, CPU 4x slowdown' : 'no network/CPU throttling',
        cache: coldEveryRun ? 'cold every run' : 'cold first run, warm after',
        evidence: 'LOCAL (synthetic shell timing, no PadlHub API)',
        cold: summarize(cold),
        warm: summarize(warm),
        samples,
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
    // Chrome may still be flushing its profile when the measurement ends; a leftover temp
    // directory must not turn a successful measurement into a failed command.
    rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // The next run creates a fresh profile directory anyway.
  }
}
