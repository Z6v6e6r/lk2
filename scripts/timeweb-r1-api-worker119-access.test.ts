import { describe, expect, it } from 'vitest';
import { r1RuntimePrivilegeRequirements } from './r1-runtime-privilege-audit.js';
import type {
  R1RuntimeComponent,
  R1RuntimePrivilegeCapture,
} from './r1-runtime-privilege-audit.js';
import {
  r1RuntimeAccessProbe,
  validateR1RuntimeAccess,
} from './timeweb-r1-api-worker119-access.js';
function capture(component: R1RuntimeComponent = 'api'): R1RuntimePrivilegeCapture {
  return {
    schema: 'PHUB_R1_RUNTIME_PRIVILEGE_CAPTURE_V1',
    component,
    capturedAt: '2026-11-03T00:00:00Z',
    databaseName: 'phub_beta',
    sessionRoleName: 'phub_runtime',
    currentRoleName: 'phub_runtime',
    roleOverride: 'none',
    readOnly: 'on',
    recovery: false,
    uuidExecute: true,
    roleFlags: {
      superuser: false,
      createRole: false,
      createDatabase: false,
      replication: false,
      bypassRls: false,
      privilegedMembership: false,
    },
    relations: r1RuntimePrivilegeRequirements(component).map((req) => ({
      relation: req.relation,
      present: true,
      kind: 'r',
      schemaUsage: true,
      schemaCreate: false,
      ownerAssumable: false,
      schemaOwnerAssumable: false,
      rls: req.tenantTable,
      forceRls: req.tenantTable,
      publicDml: false,
      dangerousDdl: false,
      tablePrivileges: [...req.privileges],
      columnCount: 1 + req.updateColumns.length,
      columns: ['id', ...req.updateColumns].map((name) => ({
        name,
        privileges: [
          ...req.privileges.filter((p) => p !== 'DELETE'),
          ...(!req.privileges.includes('UPDATE') &&
          (req.updateColumns.includes(name) || req.rowLock)
            ? ['UPDATE' as const]
            : []),
        ],
      })),
    })),
  };
}
describe('actual R1 application connection gate', () => {
  it.each(['api', 'worker'] as const)('accepts complete %s capabilities', (c) => {
    expect(() => validateR1RuntimeAccess(capture(c), c)).not.toThrow();
  });
  it('allows only reviewed grant gaps before the ACL step, never after it', () => {
    const v = capture();
    const row = v.relations.find((x) => x.relation === 'games.quarter_create_attempts')!;
    row.tablePrivileges = [];
    row.columns.forEach((x) => (x.privileges = []));
    expect(() => validateR1RuntimeAccess(v, 'api', true)).not.toThrow();
    expect(() => validateR1RuntimeAccess(v, 'api')).toThrow();
  });
  it.each(['parent', 'role', 'target', 'rls', 'missing', 'owner'])(
    'rejects %s even before grants',
    (kind) => {
      const v = capture();
      if (kind === 'parent') {
        const r = v.relations.find((x) => x.relation === 'identity.users')!;
        r.tablePrivileges = [];
        r.columns.forEach((x) => (x.privileges = []));
      }
      if (kind === 'role') v.roleFlags.bypassRls = true;
      if (kind === 'target') v.databaseName = 'foreign';
      if (kind === 'rls')
        v.relations.find((x) => x.relation === 'games.quarter_create_attempts')!.forceRls = false;
      if (kind === 'missing') {
        const r = v.relations[0]!;
        r.present = false;
        r.kind = null;
        r.columnCount = 0;
        r.columns = [];
      }
      if (kind === 'owner') v.relations[0]!.ownerAssumable = true;
      expect(() => validateR1RuntimeAccess(v, 'api', true)).toThrow();
    },
  );
  it('pins actual URL and DNS before connecting, returns no credentials and forbids foreign address input', () => {
    const source = r1RuntimeAccessProbe('api', ['172.20.0.2']);
    expect(source).toContain("u.username!=='phub_runtime'");
    expect(source.indexOf('u.hostname=a.address')).toBeLessThan(source.indexOf('new Client'));
    expect(source).toContain('REPEATABLE READ READ ONLY');
    expect(source).toContain('process.stdout.write(JSON.stringify(r.rows[0].capture))');
    expect(() => r1RuntimeAccessProbe('api', [])).toThrow();
    expect(() => r1RuntimeAccessProbe('api', ['external.example'])).toThrow();
  });
});
