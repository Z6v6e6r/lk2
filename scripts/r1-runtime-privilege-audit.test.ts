import { describe, expect, it } from 'vitest';
import {
  assessR1RuntimePrivileges,
  r1RuntimePrivilegeQuery,
  r1RuntimePrivilegeRequirements,
} from './r1-runtime-privilege-audit.js';
import type {
  R1RuntimeComponent,
  R1RuntimePrivilegeCapture,
} from './r1-runtime-privilege-audit.js';

const expected = (component: R1RuntimeComponent = 'api') => ({
  component,
  databaseName: 'r1_fixture',
  roleName: 'r1_runtime_fixture',
});
function capture(component: R1RuntimeComponent = 'api'): R1RuntimePrivilegeCapture {
  return {
    schema: 'PHUB_R1_RUNTIME_PRIVILEGE_CAPTURE_V1',
    component,
    capturedAt: '2026-11-03T00:00:00Z',
    databaseName: 'r1_fixture',
    sessionRoleName: 'r1_runtime_fixture',
    currentRoleName: 'r1_runtime_fixture',
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
const row = (value: R1RuntimePrivilegeCapture, name: string) =>
  value.relations.find((r) => r.relation === name)!;

describe('R1 current-connection catalog privilege diagnostic', () => {
  it.each(['api', 'worker'] as const)(
    'never grants activation even when %s requirements are satisfied',
    (component) => {
      expect(assessR1RuntimePrivileges(capture(component), expected(component))).toMatchObject({
        status: 'SATISFIED',
        activationAllowed: false,
        issues: [],
      });
    },
  );
  it('keeps the reviewed18 new relations, runtime source provisioning and tournament witness distinct', () => {
    const a = r1RuntimePrivilegeRequirements('api'),
      w = r1RuntimePrivilegeRequirements('worker');
    expect(new Set([...a, ...w].filter((r) => r.tenantTable).map((r) => r.relation)).size).toBe(18);
    expect(w.find((r) => r.relation === 'booking.tournament_local_attempts')?.privileges).toEqual([
      'SELECT',
    ]);
    expect(
      w.find((r) => r.relation === 'notifications.station_message_sources')?.privileges,
    ).toEqual(['SELECT', 'UPDATE']);
    expect(
      w.find((r) => r.relation === 'notifications.legacy_game_reminder_recipients')?.privileges,
    ).toEqual(['SELECT', 'INSERT', 'DELETE']);
    expect(a.find((r) => r.relation === 'integration.game_create_location_bindings')).toMatchObject(
      { privileges: ['SELECT'], rowLock: true },
    );
    a[0]!.privileges.push('DELETE');
    expect(r1RuntimePrivilegeRequirements('api')[0]!.privileges).not.toContain('DELETE');
  });
  it('uses current connection and catalog-only parameterized SQL, without accepting a target role or relation', () => {
    const query = r1RuntimePrivilegeQuery('worker');
    expect(query.values[1]).toBe('worker');
    expect(query.text).toContain('current_user');
    expect(query.text).toContain("current_setting('transaction_read_only')");
    expect(query.text).not.toMatch(
      /\b(grant|revoke|insert\s+into|update\s+\w+\s+set|delete\s+from|alter\s+table|create\s+table)\b/i,
    );
    expect(() => r1RuntimePrivilegeQuery('migrator' as R1RuntimeComponent)).toThrow(
      'R1_RUNTIME_PRIVILEGE_CAPTURE_INVALID',
    );
  });
  it('accepts command UPDATE on its two columns, and rejects broad UPDATE or DELETE', () => {
    const v = capture(),
      command = row(v, 'identity.external_subject_link_commands');
    expect(command.tablePrivileges).not.toContain('UPDATE');
    expect(assessR1RuntimePrivileges(v, expected()).status).toBe('SATISFIED');
    command.columns.find((c) => c.name === 'completed_at')!.privileges = ['SELECT', 'INSERT'];
    expect(assessR1RuntimePrivileges(v, expected()).issues).toContainEqual(
      expect.objectContaining({ code: 'COLUMN_UPDATE_MISSING', privilege: 'completed_at' }),
    );
    command.tablePrivileges.push('DELETE');
    expect(assessR1RuntimePrivileges(v, expected()).issues).toContainEqual(
      expect.objectContaining({ code: 'SUBJECT_COMMAND_WRITE_SCOPE_TOO_BROAD' }),
    );
  });
  it('requires used_at UPDATE for a consumed launch and does not invent broad UPDATE', () => {
    const v = capture(),
      launch = row(v, 'commerce.monthly_purchase_launches');
    launch.columns.find((c) => c.name === 'used_at')!.privileges = ['SELECT', 'INSERT'];
    expect(assessR1RuntimePrivileges(v, expected()).issues).toContainEqual(
      expect.objectContaining({
        code: 'COLUMN_UPDATE_MISSING',
        relation: launch.relation,
        privilege: 'used_at',
      }),
    );
  });
  it('accepts one UPDATE column for row locking while retaining SELECT coverage', () => {
    const v = capture(),
      parent = row(v, 'identity.users');
    expect(parent.tablePrivileges).toEqual(['SELECT']);
    expect(assessR1RuntimePrivileges(v, expected()).status).toBe('SATISFIED');
    parent.columns[0]!.privileges = ['SELECT'];
    expect(assessR1RuntimePrivileges(v, expected()).issues).toContainEqual(
      expect.objectContaining({ code: 'ROW_LOCK_UPDATE_MISSING', relation: 'identity.users' }),
    );
  });
  it('distinguishes full-column capability, partial-column review and no privilege', () => {
    const v = capture(),
      target = row(v, 'games.quarter_create_attempts');
    target.tablePrivileges = ['SELECT', 'INSERT'];
    target.columns.push({ name: 'state', privileges: ['SELECT', 'INSERT', 'UPDATE'] });
    target.columnCount++;
    expect(assessR1RuntimePrivileges(v, expected()).status).toBe('SATISFIED');
    target.columns[0]!.privileges = ['SELECT', 'INSERT'];
    expect(assessR1RuntimePrivileges(v, expected())).toMatchObject({
      status: 'REVIEW_REQUIRED',
      issues: [
        {
          code: 'COLUMN_SCOPE_REVIEW_REQUIRED',
          relation: target.relation,
          privilege: 'UPDATE',
          review: true,
        },
      ],
    });
    target.columns[1]!.privileges = ['SELECT', 'INSERT'];
    expect(assessR1RuntimePrivileges(v, expected()).issues).toContainEqual(
      expect.objectContaining({ code: 'PRIVILEGE_MISSING', privilege: 'UPDATE' }),
    );
  });
  it.each(['databaseName', 'sessionRoleName', 'currentRoleName'] as const)(
    'rejects changed %s binding',
    (field) => {
      const v = capture();
      v[field] = 'other_fixture';
      expect(assessR1RuntimePrivileges(v, expected()).status).toBe('BLOCKED');
    },
  );
  it.each([
    'superuser',
    'createRole',
    'createDatabase',
    'replication',
    'bypassRls',
    'privilegedMembership',
  ] as const)('blocks unsafe role capability %s', (flag) => {
    const v = capture();
    v.roleFlags[flag] = true;
    expect(assessR1RuntimePrivileges(v, expected()).status).toBe('BLOCKED');
  });
  it('blocks role override, writable capture and missing relation without treating absence as success', () => {
    const v = capture();
    v.roleOverride = 'r1_runtime_fixture';
    v.readOnly = 'off';
    Object.assign(v.relations[0]!, {
      present: false,
      kind: null,
      columnCount: 0,
      columns: [],
      tablePrivileges: [],
    });
    expect(assessR1RuntimePrivileges(v, expected()).issues.map((i) => i.code)).toEqual(
      expect.arrayContaining([
        'ROLE_OVERRIDE',
        'READ_ONLY_PRIMARY_CAPTURE_REQUIRED',
        'RELATION_MISSING',
      ]),
    );
  });
  it.each(['forceRls', 'rls', 'schemaUsage'] as const)(
    'blocks missing %s for a new tenant relation',
    (field) => {
      const v = capture();
      row(v, 'games.quarter_create_attempts')[field] = false;
      expect(assessR1RuntimePrivileges(v, expected()).status).toBe('BLOCKED');
    },
  );
  it.each([
    'publicDml',
    'schemaCreate',
    'schemaOwnerAssumable',
    'ownerAssumable',
    'dangerousDdl',
  ] as const)('blocks unsafe relation capability %s', (field) => {
    const v = capture();
    row(v, 'games.quarter_create_attempts')[field] = true;
    expect(assessR1RuntimePrivileges(v, expected()).status).toBe('BLOCKED');
  });
  it('rejects an omitted column rather than treating the remaining privileges as complete', () => {
    const v = capture();
    row(v, 'identity.external_subject_link_commands').columns.pop();
    expect(() => assessR1RuntimePrivileges(v, expected())).toThrow(
      'R1_RUNTIME_PRIVILEGE_CAPTURE_INVALID',
    );
  });
  it('rejects duplicate, omitted, extra or malformed evidence', () => {
    const v = capture();
    v.relations[1] = structuredClone(v.relations[0]!);
    expect(() => assessR1RuntimePrivileges(v, expected())).toThrow();
    const missing = capture();
    missing.relations.pop();
    expect(() => assessR1RuntimePrivileges(missing, expected())).toThrow();
    expect(() => assessR1RuntimePrivileges({ ...capture(), admitted: true }, expected())).toThrow();
    const bad = capture();
    (bad.roleFlags as Record<string, unknown>).superuser = 'false';
    expect(() => assessR1RuntimePrivileges(bad, expected())).toThrow();
  });
});
