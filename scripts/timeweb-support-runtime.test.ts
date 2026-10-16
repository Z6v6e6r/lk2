import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import {
  safeRuntimeEnvironments,
  encodeEnvironment,
} from './timeweb-beta-activation-inputs.fixture.js';
import {
  assertTimewebSupportDatabaseUrl,
  validateTimewebRuntimeEnvironments,
  validateTimewebSupportDatabaseSecretDelta,
} from './provision-timeweb-beta-runtime-secrets.js';
const roots: string[] = [];
const uid = process.getuid?.() ?? 0,
  gid = process.getgid?.() ?? 0;
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'phub-support-secret-unit-'));
  roots.push(root);
  const previous = join(root, 'previous'),
    candidate = join(root, 'candidate');
  mkdirSync(previous, { mode: 0o700 });
  mkdirSync(candidate, { mode: 0o700 });
  const environments = safeRuntimeEnvironments();
  const oldId = '1'.repeat(40) + '-123456789-1',
    newId = '2'.repeat(40) + '-234567890-1';
  const main = new URL(environments.api!.DATABASE_URL!);
  main.username = 'support_runtime';
  main.password = 'synthetic-support-runtime-unique';
  const support = main.toString();
  for (const [directory, id] of [
    [previous, oldId],
    [candidate, newId],
  ]) {
    writeFileSync(
      join(directory!, '.release-identity.json'),
      JSON.stringify({ schema: 'PHUB_TIMEWEB_SECRET_SET_V1', releaseId: id }) + '\n',
      { mode: 0o600 },
    );
    for (const name of ['api', 'worker', 'realtime', 'migrator'])
      writeFileSync(
        join(directory!, name + '.env'),
        encodeEnvironment({
          ...environments[name],
          ...(directory === candidate && ['api', 'worker'].includes(name)
            ? { SUPPORT_DATABASE_URL: support }
            : {}),
        }),
        { mode: 0o600 },
      );
  }
  return { previous, candidate, environments, support };
}
describe('closed support secret capability', () => {
  it('preserves every old env byte and accepts only identical API/Worker support credentials', () => {
    const f = fixture();
    expect(
      validateTimewebSupportDatabaseSecretDelta(f.previous, f.candidate, uid, gid).candidate
        .releaseId,
    ).toMatch(/^2{40}-/);
  });
  it.each(['worker-mismatch', 'fcm', 'realtime', 'migrator', 'other-api-value'])(
    'rejects %s without permitting an unrelated secret/flag change',
    (change) => {
      const f = fixture();
      const service =
        change === 'realtime' || change === 'migrator'
          ? change
          : change === 'worker-mismatch'
            ? 'worker'
            : 'api';
      const values: Record<string, string> = {
        ...f.environments[service],
        ...(['api', 'worker'].includes(service) ? { SUPPORT_DATABASE_URL: f.support } : {}),
      };
      if (change === 'worker-mismatch')
        values.SUPPORT_DATABASE_URL = f.support.replace('support_runtime', 'other_runtime');
      else if (change === 'fcm') values.FCM_ENABLED = 'true';
      else values.LOG_LEVEL = 'debug';
      writeFileSync(join(f.candidate, service + '.env'), encodeEnvironment(values), {
        mode: 0o600,
      });
      expect(() =>
        validateTimewebSupportDatabaseSecretDelta(f.previous, f.candidate, uid, gid),
      ).toThrow();
    },
  );
  it('keeps support optional, checks same database/different decoded principal, and denies Realtime credentials', () => {
    const f = fixture();
    const same = new URL(f.environments.api!.DATABASE_URL!);
    same.username = encodeURIComponent(same.username);
    expect(() =>
      assertTimewebSupportDatabaseUrl(f.environments.api!.DATABASE_URL!, same.toString()),
    ).toThrow();
    expect(() =>
      validateTimewebRuntimeEnvironments(
        {
          ...f.environments,
          realtime: { ...f.environments.realtime, SUPPORT_DATABASE_URL: f.support },
        } as never,
        { host: 'lk2.padlhub.su', tenantKey: 'local-padel' },
      ),
    ).toThrow();
  });
});
