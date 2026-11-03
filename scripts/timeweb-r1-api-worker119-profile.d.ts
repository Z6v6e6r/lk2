export const R1_API_WORKER119_OPERATION: string;
export const R1_API_WORKER119_PLAN: string;
export const R1_API_WORKER119_RECEIPT: string;
export const R1_API_WORKER119_INSTALLED: string;
export function isR1ApiWorker119(op: unknown): boolean;
export function validateR1ApiWorker119Operation(op: unknown, at?: number): unknown;
export function validateR1ApiWorker119Manifest(op: unknown, manifest: unknown): unknown;
export function validateR1ApiWorker119Ledger(applied: unknown, packaged: unknown): void;
export function r1ApiWorker119MigrationProof(op: unknown, completed: unknown): unknown;
