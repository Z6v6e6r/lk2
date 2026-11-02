export interface R1MigrationRow {
  filename: string;
  checksum: string;
}
export interface R1TailTarget {
  databaseName: 'phub_beta';
  systemIdentifier: '7679125609183186977';
  fromCount: number;
  catalogVariant: 'DORMANT' | 'SCENARIO_EDITOR_V1';
  catalogsSha256: string;
}
export interface R1TailCatalogs {
  schema: string;
  status: string;
  inventorySha256: string;
  builderSha256: string;
  variants: Record<string, Record<string, Record<string, { sha256: string; rowCount: number }>>>;
}
export const R1_TAIL: {
  schema: string;
  inventory: R1MigrationRow[];
  checkpoints: Record<string, string>;
  budgets: { advisoryMs: number; lockMs: number; statementMs: number; attemptMs: number };
};
export const R1_TAIL_ARGUMENT: string;
export const R1_TAIL_TARGET: { databaseName: 'phub_beta'; systemIdentifier: '7679125609183186977' };
export const R1_TAIL_OWNERS: Readonly<Record<string, string>>;
export function r1Hash(value: string | Buffer): string;
export function r1Encode(value: unknown): Buffer;
export function r1Same(a: unknown, b: unknown): boolean;
export function r1Stop(code: string): never;
export function r1Exact(value: unknown, keys: readonly string[]): void;
export function r1LedgerCount(rows: readonly R1MigrationRow[]): number;
export function r1PackagedInventory(rows: readonly R1MigrationRow[]): readonly R1MigrationRow[];
export function parseR1TailTarget(value: unknown): R1TailTarget;
export function validateR1TailCatalogs(
  value: unknown,
  bytes: Buffer,
  expectedSha256: string,
): R1TailCatalogs;
export function validateR1TailCatalog(
  rows: unknown,
  catalogs: R1TailCatalogs,
  variant: string,
  count: number,
  phase?: string,
): void;
