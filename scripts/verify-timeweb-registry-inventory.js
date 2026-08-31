#!/usr/bin/env node

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const services = ['api', 'migrator', 'realtime', 'web', 'worker'];
const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const shaPattern = /^[0-9a-f]{40}$/u;
const positiveIntegerPattern = /^[1-9][0-9]*$/u;

const fail = (message) => {
  throw new Error(`PHUB_TIMEWEB_REGISTRY_INVENTORY_INVALID: ${message}`);
};

const [
  inventoryPath,
  evidenceDirectory,
  expectedSourceSha,
  expectedWorkflowSha,
  runId,
  runAttempt,
] = process.argv.slice(2);
if (
  !inventoryPath ||
  !evidenceDirectory ||
  !shaPattern.test(expectedSourceSha ?? '') ||
  !shaPattern.test(expectedWorkflowSha ?? '') ||
  !positiveIntegerPattern.test(runId ?? '') ||
  runAttempt !== '1'
) {
  fail('invalid arguments');
}

const parseJson = async (path) => {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    fail(`unreadable JSON: ${path}`);
  }
};

const inventory = await parseJson(inventoryPath);
if (
  inventory?.schemaVersion !== 1 ||
  inventory?.kind !== 'phub-timeweb-amd64-registry-inventory' ||
  inventory?.sourceSha !== expectedSourceSha ||
  inventory?.workflowSha !== expectedWorkflowSha ||
  inventory?.platform !== 'linux/amd64' ||
  inventory?.runId !== runId ||
  inventory?.runAttempt !== runAttempt ||
  inventory?.presentImages !== 5 ||
  inventory?.expectedImages !== 5 ||
  inventory?.complete !== true ||
  inventory?.authorizesDeploy !== false ||
  !Array.isArray(inventory?.images) ||
  inventory.images.length !== 5
) {
  fail('inventory envelope mismatch');
}

const evidenceFiles = (await readdir(evidenceDirectory))
  .filter((name) => name.endsWith('-image.json'))
  .sort();
if (evidenceFiles.length !== 5) fail('expected exactly five image evidence files');

const evidenceByService = new Map();
for (const file of evidenceFiles) {
  const evidence = await parseJson(join(evidenceDirectory, file));
  if (!services.includes(evidence?.service) || evidenceByService.has(evidence.service)) {
    fail('invalid or duplicate evidence service');
  }
  evidenceByService.set(evidence.service, evidence);
}

const inventoryByService = new Map();
for (const entry of inventory.images) {
  if (!services.includes(entry?.service) || inventoryByService.has(entry.service)) {
    fail('invalid or duplicate inventory service');
  }
  inventoryByService.set(entry.service, entry);
}

const expectedTag = `amd64-sha-${expectedSourceSha}-${runId}-${runAttempt}`;
for (const service of services) {
  const evidence = evidenceByService.get(service);
  const entry = inventoryByService.get(service);
  const expectedRepository = `ghcr.io/z6v6e6r/phub-${service}`;
  if (!evidence || !entry) fail(`missing service: ${service}`);
  if (
    evidence.sourceSha !== expectedSourceSha ||
    evidence.workflowSha !== expectedWorkflowSha ||
    evidence.runId !== runId ||
    evidence.runAttempt !== runAttempt ||
    evidence.repository !== expectedRepository ||
    evidence.publicationTag !== expectedTag ||
    !digestPattern.test(evidence.indexDigest ?? '')
  ) {
    fail(`image evidence mismatch: ${service}`);
  }
  if (
    entry.repository !== expectedRepository ||
    entry.publicationTag !== expectedTag ||
    entry.status !== 'present' ||
    !digestPattern.test(entry.indexDigest ?? '') ||
    entry.indexDigest !== evidence.indexDigest
  ) {
    fail(`registry digest mismatch: ${service}`);
  }
}

console.log('PHUB_TIMEWEB_REGISTRY_INVENTORY_VERIFIED');
