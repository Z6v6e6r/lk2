import type { ApiWorkerControllerDiffEntry } from './timeweb-api-worker-upgrade.js';
import type { ClosedProductionDependencies } from './timeweb-api-worker-migration.js';
export const CLOSED_APPLICATION_CONTROLLER_BASE: Readonly<{ sha: string; tree: string }>;
export function validateClosedApplicationControllerClosure(
  value: unknown,
): readonly ApiWorkerControllerDiffEntry[];
export function attestClosedApplicationControllerSource(
  operation: unknown,
  deps: ClosedProductionDependencies & {
    assertGitConfig?: (git: (args: string[]) => string) => unknown;
  },
): unknown;
