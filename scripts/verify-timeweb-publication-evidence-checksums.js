#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';

function fail(reason) {
  process.stderr.write(`TIMEWEB_PUBLICATION_EVIDENCE_FAILED|reason=${reason}\n`);
  process.exit(1);
}

const [evidenceDirectory] = process.argv.slice(2);
if (process.argv.length !== 3 || basename(evidenceDirectory) !== 'images') fail('usage');
const root = resolve(evidenceDirectory);
const components = ['web', 'api', 'worker', 'realtime', 'migrator'];

function listFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) fail('symlink');
    if (entry.isDirectory()) files.push(...listFiles(path));
    else if (entry.isFile()) files.push(path);
    else fail('file_type');
  }
  return files;
}

let files;
try {
  files = listFiles(root);
} catch {
  fail('input_unavailable');
}
const sidecars = files.filter((path) => path.endsWith('-evidence-checksums.txt'));
if (sidecars.length !== components.length) fail('sidecar_set');
const referenced = new Set();

for (const component of components) {
  const sidecar = join(root, `${component}-evidence-checksums.txt`);
  if (!sidecars.includes(sidecar)) fail('sidecar_set');
  let contents;
  try {
    contents = readFileSync(sidecar, 'utf8');
  } catch {
    fail('sidecar_unavailable');
  }
  const lines = contents.split('\n');
  if (lines.at(-1) !== '') fail('sidecar_format');
  lines.pop();
  if (lines.length === 0) fail('sidecar_empty');
  for (const line of lines) {
    const match = line.match(/^([a-f0-9]{64}) {2}publication-evidence\/([^\s]+)$/u);
    if (!match) fail('sidecar_format');
    const [, expectedDigest, relativePath] = match;
    if (!relativePath.startsWith(`${component}-`) || relativePath.split('/').includes('..'))
      fail('sidecar_path');
    const path = resolve(root, relativePath);
    if (!path.startsWith(`${root}${sep}`) || referenced.has(path)) fail('sidecar_path');
    let stat;
    let bytes;
    try {
      stat = lstatSync(path);
      bytes = readFileSync(path);
    } catch {
      fail('evidence_unavailable');
    }
    if (!stat.isFile() || stat.isSymbolicLink()) fail('file_type');
    if (createHash('sha256').update(bytes).digest('hex') !== expectedDigest)
      fail('checksum_mismatch');
    referenced.add(path);
  }
  for (const required of [
    `${component}-image.json`,
    `${component}-provenance.json`,
    `${component}-sbom.spdx.json`,
  ]) {
    if (!referenced.has(join(root, required))) fail('required_evidence');
  }
}

const evidenceFiles = files.filter((path) => !path.endsWith('-evidence-checksums.txt'));
if (
  evidenceFiles.length !== referenced.size ||
  evidenceFiles.some((path) => !referenced.has(path)) ||
  [...referenced].some((path) => relative(root, path).startsWith('..'))
)
  fail('unreferenced_evidence');

process.stdout.write('TIMEWEB_PUBLICATION_EVIDENCE_PASSED|values_printed=false\n');
