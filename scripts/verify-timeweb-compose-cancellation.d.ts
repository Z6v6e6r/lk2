export function requireCancellationEvidence(
  mode: string,
  exitStatus: number,
  stdout: string,
  status: string,
  cleanup: string,
): {
  identity: { project: string; directory: string };
  topology: { worker: number; rehearsal: number; supervisor: number };
};
