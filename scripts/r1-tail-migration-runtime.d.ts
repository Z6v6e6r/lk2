import type {
  R1TailCompletedReference,
  validateR1TailCompletedEvidence,
} from './r1-tail-migration-controller.js';
export function readCompletedR1TailEvidence(
  reference: R1TailCompletedReference,
  dependencies?: {
    read: (path: string) => Buffer;
    backup: (op: unknown, fresh: boolean) => unknown;
  },
): ReturnType<typeof validateR1TailCompletedEvidence>;

export function attestCompletedR1TailRuntime(
  reference: R1TailCompletedReference,
  grants?: unknown,
): ReturnType<typeof readCompletedR1TailEvidence>;
