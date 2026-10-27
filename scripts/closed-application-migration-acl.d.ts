export type ClosedApplicationAclProfile = 'game_start_0103' | 'subject_link_0104';
export interface ClosedApplicationAclRow {
  readonly key: string;
  readonly owner: 'phub_beta';
  readonly aclIsNull: boolean;
  readonly effective: Readonly<Record<string, boolean>>;
  readonly acl: ReadonlyArray<readonly [string, string, string, boolean]>;
}
export interface ClosedApplicationAclPlan {
  readonly profile: ClosedApplicationAclProfile;
  readonly preimage: readonly ClosedApplicationAclRow[];
  readonly bootstrap: readonly ClosedApplicationAclRow[];
  readonly added: ReadonlyArray<readonly [string, string]>;
  readonly bootstrapSql: string;
  readonly cleanupSql: string;
  readonly preimageSha256: string;
  readonly bootstrapSha256: string;
  readonly cleanupSha256: string;
}
export function closedApplicationAclSql(profile: ClosedApplicationAclProfile): string;
export function validateClosedApplicationAcl(
  profile: ClosedApplicationAclProfile,
  rows: unknown,
): readonly ClosedApplicationAclRow[];
export function closedApplicationAclPlan(
  profile: ClosedApplicationAclProfile,
  preimage: unknown,
): ClosedApplicationAclPlan;
