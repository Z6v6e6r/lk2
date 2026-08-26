interface ProvisionRuntimeSecretsOptions {
  readonly sourceDir: string;
  readonly host: string;
  readonly tenantKey: string;
  readonly releaseId: string;
  readonly targetDir?: string;
  readonly backupRoot?: string;
  readonly expectedUid?: number;
  readonly expectedGid?: number;
}

export function provisionRuntimeSecrets(options: ProvisionRuntimeSecretsOptions): {
  readonly previousBackedUp: boolean;
};
