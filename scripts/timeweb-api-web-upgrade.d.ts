export function readInstalledApiBaseline(
  releaseId: string,
  options?: { checkRuntimeSecrets?: boolean },
): {
  path: string;
  bytes: Buffer;
  values: Record<string, string>;
  secretSetReleaseId: string;
};
