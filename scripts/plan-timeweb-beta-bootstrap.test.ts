import { describe, expect, it } from 'vitest';

import { SECRET_FILES } from './preflight-timeweb-beta-deploy.js';
import {
  evaluateBootstrap,
  type BootstrapFacts,
  type RoleFacts,
} from './plan-timeweb-beta-bootstrap.js';
import { evaluateCapacity } from './timeweb-restore-capacity.js';

const GIB = 1024 ** 3;

function role(overrides: Partial<RoleFacts> = {}): RoleFacts {
  return {
    exists: true,
    superUser: false,
    createRole: false,
    createDatabase: false,
    replication: false,
    bypassRls: false,
    databaseCreate: true,
    schemaCreate: true,
    uncoveredTables: 0,
    totalTables: 10,
    ...overrides,
  };
}

function facts(overrides: Partial<BootstrapFacts> = {}): BootstrapFacts {
  return {
    runtime: role(),
    migrator: role(),
    secretFiles: [...SECRET_FILES],
    secretModes: Object.fromEntries(SECRET_FILES.map((name) => [name, 0o600])),
    installedReleaseId: '8158ac445c9ff3e4b4bcee95bbd8e10c564b9a8d-39366813227-1',
    candidate: 'ready',
    candidateDetail: 'candidate set present fcm=true',
    fcmCredential: true,
    monitorReadback: true,
    alertReadback: true,
    capacity: evaluateCapacity(1 * GIB, 8 * GIB, 45 * GIB),
    phase: 'post101',
    ...overrides,
  };
}

describe('beta bootstrap plan', () => {
  it('is READY with least-privilege roles, secrets, FCM and monitoring evidence', () => {
    const plan = evaluateBootstrap(facts());
    expect(plan.summary).toMatchObject({ status: 'READY', blockers: 0, actions: 0 });
    expect(plan.summary.restoreSchema).toContain('DISK_NAMESPACE_V2');
  });

  it('blocks a missing role, forbidden privileges and missing or unsafe secrets', () => {
    const plan = evaluateBootstrap(
      facts({
        runtime: null,
        migrator: role({ bypassRls: true, databaseCreate: false }),
        secretFiles: SECRET_FILES.filter((name) => name !== 'api.env'),
        secretModes: { ...facts().secretModes, 'worker.env': 0o644 },
        installedReleaseId: null,
        candidate: 'invalid',
        capacity: evaluateCapacity(9.5 * GIB, 8.9 * GIB, 20 * GIB),
      }),
    );
    expect(plan.summary.status).toBe('NOT_READY');
    const ids = plan.checks.filter((c) => c.status === 'BLOCKER').map((c) => c.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'role-runtime',
        'role-migrator',
        'role-migrator-db-create',
        'secrets-installed',
        'secrets-mode',
        'secrets-candidate',
        'restore-capacity',
      ]),
    );
  });

  it('reports actionable gaps without blocking the host', () => {
    const plan = evaluateBootstrap(
      facts({
        runtime: role({ uncoveredTables: 2 }),
        candidate: 'absent',
        candidateDetail: 'no --candidate-dir provided',
        fcmCredential: false,
        monitorReadback: false,
        alertReadback: false,
        capacity: evaluateCapacity(9.5 * GIB, 8.9 * GIB, 45 * GIB),
      }),
    );
    expect(plan.summary).toMatchObject({ status: 'READY', blockers: 0, actions: 5 });
    expect(plan.summary.restoreSchema).toContain('DISK_V1');
    expect(plan.checks.find((c) => c.id === 'restore-capacity')?.detail).toContain('model=disk');
  });
});
