import {
  readFileSync,
  mkdtempSync,
  statSync,
  readdirSync,
  rmSync,
  symlinkSync,
  chmodSync,
  linkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  assertOwned,
  makeModel,
  projectFor,
  validateEndpoint,
  previewReady,
  atomicJson,
  atomicPrivateFile,
  finishOperation,
  assertResumeVolumes,
  assertPrivatePath,
  uncertainCompletion,
} from './lk2-local.js';

const root = resolve(import.meta.dirname, '..');
const base = parse(readFileSync(resolve(root, 'compose.yaml'), 'utf8')) as unknown;
const lock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8')) as unknown;

describe('local preview isolation boundary', () => {
  it('rejects remote, loopback TCP, custom and substituted endpoints', () => {
    for (const [context, endpoint] of [
      ['production', 'ssh://host'],
      ['default', 'tcp://127.0.0.1:2375'],
      ['desktop-linux', 'unix:///tmp/foreign.sock'],
      ['unknown', 'unix:///var/run/docker.sock'],
    ] as const) {
      expect(() => validateEndpoint(context, endpoint)).toThrow(/unknown/);
    }
    expect(() => validateEndpoint('default', 'unix:///var/run/docker.sock')).not.toThrow();
  });
  it('requires both Compose and worktree custody before resource adoption', () => {
    const project = projectFor(root);
    const labels = { 'com.docker.compose.project': project, 'dev.padlhub.worktree': root };
    expect(() =>
      assertOwned([{ Name: 'owned', Labels: labels }], root, project, 'volume'),
    ).not.toThrow();
    for (const bad of [
      {},
      { ...labels, 'dev.padlhub.worktree': '/other/task' },
      { ...labels, 'com.docker.compose.project': 'phub' },
    ]) {
      expect(() =>
        assertOwned([{ Name: 'foreign', Labels: bad }], root, project, 'volume'),
      ).toThrow(/Ownership conflict/);
    }
  });
  it('isolates worktree storage and keeps infrastructure ports private', () => {
    const one = makeModel(base, root, 'node:22-bookworm-slim', lock);
    const two = makeModel(base, `${root}-second`, 'node:22-bookworm-slim', lock);
    expect(one.name).not.toBe(two.name);
    expect(one.networks.data).toMatchObject({ internal: true });
    expect(one.networks.data).not.toHaveProperty('name');
    expect(one.services.postgres.ports).toEqual([]);
    expect(one.services.redis.ports).toEqual([]);
    expect(one.services.api).not.toHaveProperty('ports');
    expect(one.services.web.ports).toEqual(['127.0.0.1:5173:5173']);
    expect(Object.keys(one.services).sort()).toEqual([
      'api',
      'migrator',
      'postgres',
      'redis',
      'setup',
      'web',
    ]);
  });
  it('uses current source, locked installation volumes and synthetic environment only', () => {
    const model = makeModel(base, root, 'node:22-bookworm-slim', lock);
    expect(model.services.api.volumes).toContain(`${root}:/workspace`);
    expect(model.services.api.volumes).toContain(`${root}/.lk2-local/local.env:/workspace/.env:ro`);
    expect(model.services.api).not.toHaveProperty('env_file');
    expect(model.services.api).not.toHaveProperty('build');
    expect(model.services.api.environment).toMatchObject({ APP_ENV: 'local', VIVA_MODE: 'mock' });
    expect(model.services.api.environment).not.toHaveProperty('VIVA_API_KEY');
    for (const service of ['web', 'setup', 'migrator'] as const) {
      expect(model.services[service].environment).not.toHaveProperty('JWT_ACCESS_SECRET');
      expect(model.services[service].environment).not.toHaveProperty('JWT_REFRESH_SECRET');
      expect(model.services[service].volumes).toContain(
        `${root}/.lk2-local/mask:/workspace/.lk2-local:ro`,
      );
    }
    expect(model.services.setup.networks).toEqual(['install']);
    expect(model.services.migrator.networks).toEqual(['data']);
    expect(model.services.migrator.profiles).toEqual(['tools']);
    expect(model.services.api.command).toBe('npm run dev:api');
    expect(model.services.web.command).toBe('npm run dev:web');
  });
});

describe('preview recovery evidence', () => {
  it('requires all dependencies to be running and healthy before reporting ready', () => {
    const items = ['postgres', 'redis', 'api', 'web'].map((service) => ({
      Config: { Labels: { 'com.docker.compose.service': service } },
      State: { Running: true, Health: { Status: 'healthy' } },
    }));
    expect(previewReady(items, true)).toBe(true);
    expect(previewReady(items, false)).toBe(false);
    for (let index = 0; index < items.length; index++) {
      expect(
        previewReady(
          items.filter((_, position) => position !== index),
          true,
        ),
      ).toBe(false);
      const degraded = structuredClone(items);
      degraded[index]!.State.Health.Status = 'unhealthy';
      expect(previewReady(degraded, true)).toBe(false);
    }
  });
  it('rejects absent or recreated retained volumes', () => {
    const saved = [{ name: 'preview_postgres_data', createdAt: 'time-a', identity: 'nonce-a' }];
    const observed = [
      {
        Name: 'preview_postgres_data',
        CreatedAt: 'time-a',
        Labels: { 'dev.padlhub.volume-id': 'nonce-a' },
      },
    ];
    expect(() => assertResumeVolumes(saved, observed)).not.toThrow();
    expect(() => assertResumeVolumes(saved, [])).toThrow(/missing or replaced/);
    expect(() => assertResumeVolumes(saved, [{ ...observed[0], CreatedAt: 'time-b' }])).toThrow(
      /missing or replaced/,
    );
    expect(() =>
      assertResumeVolumes(saved, [
        { ...observed[0], Labels: { 'dev.padlhub.volume-id': 'nonce-b' } },
      ]),
    ).toThrow(/missing or replaced/);
  });
  it('atomically replaces complete private receipts without leftover temporary files', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'lk2-receipt-test-'));
    try {
      const path = resolve(dir, 'state.json');
      atomicJson(path, { initialized: false });
      atomicJson(path, { initialized: true, marker: 'new-complete-value' });
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
        initialized: true,
        marker: 'new-complete-value',
      });
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(readdirSync(dir)).toEqual(['state.json']);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe('private file and timeout recovery', () => {
  it('replaces symlinks without overwriting their targets and enforces private modes', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'lk2-private-file-test-'));
    try {
      const target = resolve(dir, 'untouched');
      const path = resolve(dir, 'local.env');
      writeFileSync(target, 'preserve');
      symlinkSync(target, path);
      atomicPrivateFile(path, 'synthetic');
      expect(readFileSync(target, 'utf8')).toBe('preserve');
      expect(readFileSync(path, 'utf8')).toBe('synthetic');
      expect(statSync(path).mode & 0o777).toBe(0o600);
      const permissive = resolve(dir, 'compose.json');
      writeFileSync(permissive, '{}', { mode: 0o644 });
      atomicPrivateFile(permissive, '{"synthetic":true}');
      expect(statSync(permissive).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
  it('retains the operation lock after uncertain Docker completion', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'lk2-timeout-lock-test-'));
    finishOperation(dir, true);
    expect(statSync(dir).isDirectory()).toBe(true);
    finishOperation(dir, false);
  });
});

describe('preexisting state custody', () => {
  it('rejects permissive and hard-linked credentials', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'lk2-custody-test-'));
    try {
      const path = resolve(dir, 'credentials.json');
      atomicJson(path, { synthetic: true });
      expect(() => assertPrivatePath(path)).not.toThrow();
      chmodSync(path, 0o644);
      expect(() => assertPrivatePath(path)).toThrow(/custody/);
      chmodSync(path, 0o600);
      linkSync(path, resolve(dir, 'alias'));
      expect(() => assertPrivatePath(path)).toThrow(/custody/);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
  it('retains custody for signals, timeouts and indeterminate completion', () => {
    expect(uncertainCompletion({ status: 0 })).toBe(false);
    expect(uncertainCompletion({ status: 1 })).toBe(false);
    expect(uncertainCompletion({ status: null, signal: 'SIGTERM' })).toBe(true);
    expect(uncertainCompletion({ error: { code: 'ETIMEDOUT' } })).toBe(true);
    expect(uncertainCompletion({ status: null })).toBe(true);
  });
});
