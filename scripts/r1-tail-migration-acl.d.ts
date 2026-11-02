export interface R1AclRow {
  key: string;
  owner: string;
  aclIsNull: boolean;
  props: Record<string, boolean>;
  acl: [string, string, string, boolean][];
}
export interface R1PreparationPlan {
  schema: string;
  preimage: R1AclRow[];
  preimageSha256: string;
  added: unknown[];
  bootstrapStatements: string[];
  cleanupStatements: string[];
}
export const R1_TAIL_ACL_SQL: string;
export function validateR1TailAcl(value: unknown, phase?: string): R1AclRow[];
export function r1TailPreparationPlan(value: unknown): R1PreparationPlan;
export function validateR1TailPreparation(value: unknown, preimage: unknown): R1PreparationPlan;
export function r1TailAclTransaction(
  value: R1PreparationPlan,
  phase: string,
  expected: unknown,
): string;
