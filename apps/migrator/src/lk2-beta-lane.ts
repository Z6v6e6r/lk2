// LK2 disposable beta lane (ADR-0026, AGENTS.md first-version mode).
//
// lk2.padlhub.su holds synthetic data only. This mode lets the existing migrator apply every
// pending packaged migration on that one cluster, as its superuser/database owner, without the
// production custody controllers that the ordinary mode requires for 0099-0104 and the R1 tail.
//
// The bypass is bound to the exact cluster identity below and nothing else: any other database
// name, system identifier, a non-superuser connection or a hot standby is refused before DDL.
// Ledger compatibility (no unknown or altered applied file) and the chat-push foundation gate
// still apply. When real users reach lk2, this module must be removed with the AGENTS.md bullet.
import {
  r1RuntimePrivilegeRequirements,
  type R1RuntimePrivilege,
} from '../../../scripts/r1-runtime-privilege-audit.js';

export const lk2BetaLaneMode = 'lk2_beta_lane';
export const lk2BetaLaneArgument = '--lk2-beta-lane';
export const lk2BetaLanePlanArgument = '--lk2-beta-lane-plan';

export const LK2_BETA_LANE_TARGET = {
  databaseName: 'phub_beta',
  systemIdentifier: '7679125609183186977',
} as const;

export const LK2_BETA_LANE_RUNTIME_ROLE = 'phub_runtime';

// Per-file bounds: a migration that cannot take its lock quickly fails and rolls back that file
// only; earlier files stay committed and a rerun resumes with the remaining suffix.
export const LK2_BETA_LANE_LOCK_TIMEOUT = '10s';
export const LK2_BETA_LANE_STATEMENT_TIMEOUT = '120s';

export const LK2_BETA_LANE_TARGET_SQL = `
  select current_database() as database_name,
         (select system_identifier::text from pg_catalog.pg_control_system()) as system_identifier,
         pg_catalog.pg_is_in_recovery() as recovery,
         coalesce((select rolsuper from pg_catalog.pg_roles where rolname = current_user), false) as superuser,
         exists(select 1 from pg_catalog.pg_roles where rolname = '${LK2_BETA_LANE_RUNTIME_ROLE}') as runtime_role
`;

export interface Lk2BetaLaneTargetRow {
  readonly database_name: string;
  readonly system_identifier: string;
  readonly recovery: boolean;
  readonly superuser: boolean;
  readonly runtime_role: boolean;
}

export function assertLk2BetaLaneTarget(row: Lk2BetaLaneTargetRow | undefined): void {
  if (
    !row ||
    row.database_name !== LK2_BETA_LANE_TARGET.databaseName ||
    row.system_identifier !== LK2_BETA_LANE_TARGET.systemIdentifier
  )
    throw new Error('LK2_BETA_LANE_TARGET_MISMATCH');
  if (row.recovery !== false) throw new Error('LK2_BETA_LANE_TARGET_IN_RECOVERY');
  if (row.superuser !== true) throw new Error('LK2_BETA_LANE_SUPERUSER_REQUIRED');
  if (row.runtime_role !== true) throw new Error('LK2_BETA_LANE_RUNTIME_ROLE_MISSING');
}

export interface Lk2RuntimeGrant {
  readonly relation: string;
  readonly privileges: readonly R1RuntimePrivilege[];
  readonly updateColumns: readonly string[];
}

// Tables created by 0102-0115 and the exact runtime privileges the API and Worker need on them:
// the reviewed R1 post-119 matrix plus the 0102 photo contract (runtimePhotoAcl).
// On these tables the runtime ACL is made exact (revoke all, then grant), so inherited default
// privileges cannot widen them. Older tables keep their existing reviewed grants untouched.
export function lk2RuntimeGrants(): Lk2RuntimeGrant[] {
  const merged = new Map<string, { privileges: Set<R1RuntimePrivilege>; columns: Set<string> }>();
  for (const component of ['api', 'worker'] as const)
    for (const row of r1RuntimePrivilegeRequirements(component)) {
      if (!row.tenantTable) continue;
      const entry = merged.get(row.relation) ?? { privileges: new Set(), columns: new Set() };
      for (const privilege of row.privileges) entry.privileges.add(privilege);
      for (const column of row.updateColumns) entry.columns.add(column);
      merged.set(row.relation, entry);
    }
  merged.set('locations.recommendation_card_photos', {
    privileges: new Set(['SELECT', 'INSERT', 'DELETE']),
    columns: new Set(),
  });
  return [...merged.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([relation, entry]) => ({
      relation,
      privileges: [...entry.privileges].sort(),
      // A table-level UPDATE already covers every column.
      updateColumns: entry.privileges.has('UPDATE') ? [] : [...entry.columns].sort(),
    }));
}

const identifier = (value: string): string => {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value)) throw new Error('LK2_BETA_LANE_IDENTIFIER');
  return `"${value}"`;
};
const qualified = (relation: string): string => {
  const parts = relation.split('.');
  if (parts.length !== 2) throw new Error('LK2_BETA_LANE_IDENTIFIER');
  return parts.map(identifier).join('.');
};

export function lk2RuntimeGrantStatements(grants = lk2RuntimeGrants()): string[] {
  const role = identifier(LK2_BETA_LANE_RUNTIME_ROLE);
  return grants.flatMap(({ relation, privileges, updateColumns }) => [
    `revoke all on table ${qualified(relation)} from ${role}`,
    `grant ${privileges.join(', ')} on table ${qualified(relation)} to ${role}`,
    ...(updateColumns.length > 0
      ? [
          `grant update (${updateColumns.map(identifier).join(', ')}) on table ${qualified(relation)} to ${role}`,
        ]
      : []),
  ]);
}

// Read-only check run after the grants: every listed relation exists, its schema is usable by the
// runtime role, and the runtime role holds exactly the listed table-level privileges and, where it
// has no table-level UPDATE, UPDATE on exactly the listed columns.
export const LK2_RUNTIME_GRANT_VERIFY_SQL = `
  select g.relation,
         to_regclass(g.relation) is not null as present,
         case when to_regclass(g.relation) is null then false
              else pg_catalog.has_schema_privilege('${LK2_BETA_LANE_RUNTIME_ROLE}', split_part(g.relation, '.', 1), 'USAGE') end as schema_usage,
         case when to_regclass(g.relation) is null then null
              else array(select p from unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
                          where pg_catalog.has_table_privilege('${LK2_BETA_LANE_RUNTIME_ROLE}', to_regclass(g.relation), p)
                          order by p) end as privileges,
         case when to_regclass(g.relation) is null
                or pg_catalog.has_table_privilege('${LK2_BETA_LANE_RUNTIME_ROLE}', to_regclass(g.relation), 'UPDATE') then array[]::text[]
              else array(select a.attname::text from pg_catalog.pg_attribute a
                          where a.attrelid = to_regclass(g.relation) and a.attnum > 0 and not a.attisdropped
                            and pg_catalog.has_column_privilege('${LK2_BETA_LANE_RUNTIME_ROLE}', a.attrelid, a.attnum, 'UPDATE')
                          order by a.attname collate "C") end as update_columns
    from unnest($1::text[]) as g(relation)
   order by g.relation
`;

export interface Lk2RuntimeGrantVerifyRow {
  readonly relation: string;
  readonly present: boolean;
  readonly schema_usage: boolean;
  readonly privileges: readonly string[] | null;
  readonly update_columns: readonly string[];
}

export function assertLk2RuntimeGrants(
  rows: readonly Lk2RuntimeGrantVerifyRow[],
  grants = lk2RuntimeGrants(),
): void {
  if (rows.length !== grants.length) throw new Error('LK2_BETA_LANE_GRANT_VERIFY');
  for (const [index, grant] of grants.entries()) {
    const row = rows[index]!;
    if (row.relation !== grant.relation || !row.present)
      throw new Error(`LK2_BETA_LANE_GRANT_RELATION_MISSING:${grant.relation}`);
    if (!row.schema_usage) throw new Error(`LK2_BETA_LANE_SCHEMA_USAGE_MISSING:${grant.relation}`);
    const actual = [...(row.privileges ?? [])].sort().join(',');
    if (actual !== [...grant.privileges].sort().join(','))
      throw new Error(`LK2_BETA_LANE_GRANT_MISMATCH:${grant.relation}`);
    if ([...row.update_columns].sort().join(',') !== [...grant.updateColumns].sort().join(','))
      throw new Error(`LK2_BETA_LANE_COLUMN_GRANT_MISMATCH:${grant.relation}`);
  }
}

// Existing parent tables that the new code reads under FOR SHARE/UPDATE row locks. PostgreSQL
// requires SELECT plus UPDATE on at least one column for those locks. These tables predate the
// lane, so their grants are only ever added to (never revoked): missing SELECT, or a missing
// UPDATE when the role has UPDATE on no column at all, is granted and reported.
export function lk2RowLockParents(): string[] {
  const parents = new Set<string>();
  for (const component of ['api', 'worker'] as const)
    for (const row of r1RuntimePrivilegeRequirements(component))
      if (!row.tenantTable && row.rowLock) parents.add(row.relation);
  return [...parents].sort();
}

export const LK2_ROW_LOCK_PARENT_SQL = `
  select g.relation,
         to_regclass(g.relation) is not null as present,
         case when to_regclass(g.relation) is null then false
              else pg_catalog.has_schema_privilege('${LK2_BETA_LANE_RUNTIME_ROLE}', split_part(g.relation, '.', 1), 'USAGE') end as schema_usage,
         case when to_regclass(g.relation) is null then false
              else pg_catalog.has_table_privilege('${LK2_BETA_LANE_RUNTIME_ROLE}', to_regclass(g.relation), 'SELECT') end as can_select,
         case when to_regclass(g.relation) is null then false
              else pg_catalog.has_any_column_privilege('${LK2_BETA_LANE_RUNTIME_ROLE}', to_regclass(g.relation), 'UPDATE') end as can_lock
    from unnest($1::text[]) as g(relation)
   order by g.relation
`;

export interface Lk2RowLockParentRow {
  readonly relation: string;
  readonly present: boolean;
  readonly schema_usage: boolean;
  readonly can_select: boolean;
  readonly can_lock: boolean;
}

export function lk2RowLockParentGaps(rows: readonly Lk2RowLockParentRow[]): {
  relation: string;
  missing: ('SELECT' | 'UPDATE')[];
}[] {
  return rows.flatMap((row) => {
    if (!row.present) throw new Error(`LK2_BETA_LANE_PARENT_MISSING:${row.relation}`);
    if (!row.schema_usage) throw new Error(`LK2_BETA_LANE_SCHEMA_USAGE_MISSING:${row.relation}`);
    const missing: ('SELECT' | 'UPDATE')[] = [];
    if (!row.can_select) missing.push('SELECT');
    if (!row.can_lock) missing.push('UPDATE');
    return missing.length > 0 ? [{ relation: row.relation, missing }] : [];
  });
}

export function lk2RowLockParentGrantStatements(
  gaps: readonly { relation: string; missing: readonly ('SELECT' | 'UPDATE')[] }[],
): string[] {
  const role = identifier(LK2_BETA_LANE_RUNTIME_ROLE);
  return gaps.map(
    ({ relation, missing }) =>
      `grant ${missing.join(', ')} on table ${qualified(relation)} to ${role}`,
  );
}
