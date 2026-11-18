#!/usr/bin/env node
// Captures rendered screenshots of two builds for a visual comparison.
//
// Usage: node scripts/perf/capture-screens.js \
//   --builds=css=http://127.0.0.1:4180,precss=http://127.0.0.1:4182 \
//   --routes=/,/games,/profile,/gift-certificates,/tournaments \
//   --widths=390,1280 --out=docs/performance/screenshots/20261118 \
//   [--loading]   also capture an early loading frame
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const raw = argv.find((value) => value.startsWith('--' + name + '='));
  return raw === undefined ? fallback : raw.slice(name.length + 3);
};
const has = (name) => argv.includes('--' + name);
const builds = flag('builds', '')
  .split(',')
  .filter(Boolean)
  .map((entry) => {
    const [name, url] = entry.split('=');
    return { name, url: url.replace(/\/$/, '') };
  });
const routes = flag('routes', '/,/games,/profile').split(',');
const widths = flag('widths', '390,1280').split(',').map(Number);
const outputDir = flag('out', 'docs/performance/screenshots');
const captureLoading = has('loading');
const chromePath =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function launch(profileDir) {
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
      '--disable-gpu',
      '--hide-scrollbars',
      '--mute-audio',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
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
  send(method, params = {}) {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error('timeout ' + method));
      }, 30000);
    });
  }
}

const profileDir = mkdtempSync(join(tmpdir(), 'phub-shots-'));
const chrome = launch(profileDir);
try {
  let port;
  for (let index = 0; index < 200; index += 1) {
    try {
      port = Number(readFileSync(join(profileDir, 'DevToolsActivePort'), 'utf8').split('\n')[0]);
      if (port) break;
    } catch {}
    await sleep(50);
  }
  const targets = await fetch('http://127.0.0.1:' + port + '/json/list').then((response) =>
    response.json(),
  );
  const page = targets.find((target) => target.type === 'page');
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  const cdp = new Cdp(socket);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');
  mkdirSync(outputDir, { recursive: true });
  for (const build of builds) {
    for (const width of widths) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width,
        height: 900,
        deviceScaleFactor: 1,
        mobile: width < 600,
      });
      for (const route of routes) {
        await cdp.send('Page.navigate', { url: build.url + route });
        if (captureLoading) {
          await sleep(120);
          const loading = await cdp.send('Page.captureScreenshot', { format: 'png' });
          writeFileSync(
            join(
              outputDir,
              build.name +
                '-' +
                width +
                '-' +
                (route === '/' ? 'home' : route.replace(/[^a-z0-9]+/gi, '-')) +
                '-loading.png',
            ),
            Buffer.from(loading.data, 'base64'),
          );
        }
        await sleep(1800);
        const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
        const name =
          build.name +
          '-' +
          width +
          '-' +
          (route === '/' ? 'home' : route.replace(/[^a-z0-9]+/gi, '-'));
        writeFileSync(join(outputDir, name + '.png'), Buffer.from(shot.data, 'base64'));
        console.log('captured', name);
      }
    }
  }
  socket.close();
} finally {
  chrome.kill('SIGKILL');
  try {
    rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {}
}
