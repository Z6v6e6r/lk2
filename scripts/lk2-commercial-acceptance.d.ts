export interface AcceptanceResult {
  name: string;
  status: 'PASS' | 'FAIL' | 'SKIP';
  detail: string;
}
export interface AcceptanceStateStore {
  load(): Record<string, unknown>;
  save(state: Record<string, unknown>): void;
}
export const ALLOWED_HOSTS: ReadonlySet<string>;
export function parseArgs(argv: readonly string[]): {
  create: boolean;
  join: boolean;
  help: boolean;
};
export function fileStateStore(path: string): AcceptanceStateStore;
export function runAcceptance(options: {
  env: Record<string, string | undefined>;
  argv: readonly string[];
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  stateStore?: AcceptanceStateStore;
}): Promise<{ results: AcceptanceResult[]; failed: number }>;
