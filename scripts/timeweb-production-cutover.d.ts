export const ROSTER_CUTOVER_OPERATION: string;
export const ROSTER_CUTOVER_PLAN: string;
export const ROSTER_CUTOVER_RECEIPT: string;
export const ROSTER_CUTOVER_KIND: string;
export function validateProductionCutover(
  value: unknown,
  fresh?: boolean,
  now?: number,
): Record<string, unknown>;
export function validateCutoverBackupOperation(
  operation: unknown,
  bytes: Buffer,
  facts: unknown,
): Record<string, unknown>;
export function legacyBaselineHash(baseline: unknown): string;
export const CANONICAL_BASELINE_SOURCE: string;
export const CANONICAL_BASELINE_RELEASE: string;
export const CANONICAL_BASELINE_SCHEMA: string;
export const CANONICAL_BASELINE_IMAGES: Readonly<Record<string, string>>;
export function validateCanonicalBaseline(baseline: unknown): Record<string, unknown>;
export function canonicalRuntimeHash(baseline: unknown): string;
export function isLegacyProductionCutover(op: unknown): boolean;
export function cutoverBaseline(op: Record<string, unknown>): Record<string, unknown>;
export function cutoverBaselineField(op: unknown): string;
export function cutoverBaselineHash(op: unknown): string;
export function cutoverPlanSchema(op: unknown): string;
export function cutoverReceiptSchema(op: unknown): string;
export function cutoverInstalledKind(op: unknown): string;
export function legacyRuntimeHash(baseline: unknown): string;
export function legacyEnvironment(
  baseline: unknown,
  bytes: Buffer,
  identity: unknown,
): Record<string, string>;
