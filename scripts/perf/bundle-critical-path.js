#!/usr/bin/env node
// Reproducible LOCAL baseline: how many bytes and files the first paint of the LK2 web shell
// needs. Derived from the real Vite build output, never from estimates.
import { existsSync, readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';

const dist = process.argv[2] ?? 'apps/web/dist';
const manifestFile = ['vite-manifest.json', '.vite/manifest.json'].find((name) =>
  existsSync(join(dist, name)),
);
if (!manifestFile) throw new Error(`no Vite manifest under ${dist}`);
const manifest = JSON.parse(readFileSync(join(dist, manifestFile), 'utf8'));

const seen = new Set();
const eager = [];
function walk(key) {
  const chunk = manifest[key];
  if (!chunk || seen.has(key)) return;
  seen.add(key);
  eager.push({ key, file: chunk.file, css: chunk.css ?? [] });
  for (const dependency of chunk.imports ?? []) walk(dependency);
}

const entryKey =
  process.argv[3] ??
  Object.keys(manifest).find((key) => key === 'index.html' || key.endsWith('/index.html')) ??
  Object.keys(manifest)[0];
if (!manifest[entryKey]) throw new Error(`entry chunk ${entryKey} not found in the Vite manifest`);
walk(entryKey);

const read = (file) => readFileSync(join(dist, file));
const bytes = { js: 0, jsGzip: 0, css: 0, cssGzip: 0 };
const files = [];
for (const chunk of eager) {
  const raw = read(chunk.file);
  bytes.js += raw.length;
  bytes.jsGzip += gzipSync(raw, { level: 9 }).length;
  files.push({ file: chunk.file, bytes: raw.length });
  for (const css of chunk.css) {
    const cssRaw = read(css);
    bytes.css += cssRaw.length;
    bytes.cssGzip += gzipSync(cssRaw, { level: 9 }).length;
    files.push({ file: css, bytes: cssRaw.length });
  }
}

const allAssets = Object.values(manifest).filter((chunk) => chunk.file);
const totalJs = allAssets.filter((chunk) => chunk.file.endsWith('.js'));
const summary = {
  entry: entryKey,
  eagerRequests: eager.length,
  criticalJsBytes: bytes.js,
  criticalJsGzipBytes: bytes.jsGzip,
  criticalCssBytes: bytes.css,
  criticalCssGzipBytes: bytes.cssGzip,
  criticalTransferGzipBytes: bytes.jsGzip + bytes.cssGzip,
  deferredAssets: allAssets.length - eager.length,
  allJsCount: totalJs.length,
  eagerFiles: files.sort((a, b) => b.bytes - a.bytes),
};

console.log(JSON.stringify(summary, null, 2));
