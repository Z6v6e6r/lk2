export type R1RuntimeComponent = 'api' | 'worker';
export type R1RuntimePrivilege = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';
export interface R1RuntimePrivilegeRequirement {
  relation: string;
  privileges: R1RuntimePrivilege[];
  updateColumns: string[];
  rowLock: boolean;
  tenantTable: boolean;
  restrictedCommandUpdates: boolean;
}
export interface R1RuntimePrivilegeCapture {
  schema: 'PHUB_R1_RUNTIME_PRIVILEGE_CAPTURE_V1';
  component: R1RuntimeComponent;
  capturedAt: string;
  databaseName: string;
  sessionRoleName: string;
  currentRoleName: string;
  roleOverride: string;
  readOnly: string;
  recovery: boolean;
  uuidExecute: boolean;
  roleFlags: Record<
    | 'superuser'
    | 'createRole'
    | 'createDatabase'
    | 'replication'
    | 'bypassRls'
    | 'privilegedMembership',
    boolean
  >;
  relations: {
    relation: string;
    present: boolean;
    kind: string | null;
    schemaUsage: boolean;
    schemaCreate: boolean;
    ownerAssumable: boolean;
    schemaOwnerAssumable: boolean;
    rls: boolean;
    forceRls: boolean;
    publicDml: boolean;
    dangerousDdl: boolean;
    tablePrivileges: R1RuntimePrivilege[];
    columnCount: number;
    columns: { name: string; privileges: Exclude<R1RuntimePrivilege, 'DELETE'>[] }[];
  }[];
}
export function r1RuntimePrivilegeRequirements(
  component: R1RuntimeComponent,
): R1RuntimePrivilegeRequirement[];
export function r1RuntimePrivilegeQuery(component: R1RuntimeComponent): {
  text: string;
  values: [string, R1RuntimeComponent];
};
export function assessR1RuntimePrivileges(
  value: unknown,
  expected: {
    component: R1RuntimeComponent;
    databaseName: string;
    roleName: string;
  },
): {
  schema: 'PHUB_R1_RUNTIME_PRIVILEGE_ASSESSMENT_V1';
  component: R1RuntimeComponent;
  status: 'SATISFIED' | 'BLOCKED' | 'REVIEW_REQUIRED';
  scope: 'R1_NEW_RELATIONS_AND_REVIEWED_ROW_LOCK_PARENTS_ONLY';
  activationAllowed: false;
  capturedAt: string;
  issues: { code: string; relation: string | null; privilege: string | null; review: boolean }[];
};
