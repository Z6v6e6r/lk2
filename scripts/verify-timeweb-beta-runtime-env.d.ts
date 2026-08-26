export type RuntimeEnvironment = Record<string, string>;

export interface RuntimeEnvironmentInput {
  readonly api: RuntimeEnvironment;
  readonly worker: RuntimeEnvironment;
  readonly realtime: RuntimeEnvironment;
  readonly migrator: RuntimeEnvironment;
  readonly host: string;
  readonly tenantKey: string;
}

export function parseEnvironment(contents: string): RuntimeEnvironment;
export function validateRuntimeEnvironments(input: RuntimeEnvironmentInput): void;
