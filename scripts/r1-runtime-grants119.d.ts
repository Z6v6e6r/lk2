export type R1Grant119Acl = [string, string, string, boolean][];
export interface R1Grant119Capture {
  databaseName: string;
  systemIdentifier: string;
  recovery: boolean;
  roleSafe: boolean;
  ledger: { filename: string; checksum: string }[];
  tables: {
    relation: string;
    owner: string;
    kind: string;
    rls: boolean;
    forceRls: boolean;
    schemaUsage: boolean;
    schemaCreate: boolean;
    schemaOwnerAssumable: boolean;
    acl: R1Grant119Acl;
    columns: { name: string; acl: R1Grant119Acl }[];
  }[];
}
export interface R1Grant119Plan {
  schema: 'PHUB_R1_RUNTIME_GRANTS119_V1';
  preimage: R1Grant119Capture;
  preimageSha256: string;
  postimage: R1Grant119Capture;
  postimageSha256: string;
  changes: {
    action: 'grant' | 'revoke';
    relation: string;
    column: string | null;
    privilege: string;
  }[];
}
export const R1_RUNTIME_GRANT_CATALOG_SQL: string;
export function planR1RuntimeGrants119(preimage: R1Grant119Capture): R1Grant119Plan;
export function r1RuntimeGrantTransaction119(
  plan: R1Grant119Plan,
  phase: 'apply' | 'recover',
): string;

export function r1RuntimeGrantCatalog119(
  catalog: Array<{ key: string; value: string }>,
  plan: ReturnType<typeof planR1RuntimeGrants119>,
): Array<{ key: string; value: string }>;
