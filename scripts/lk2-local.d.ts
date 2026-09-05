interface LocalService {
  command?: string;
  image?: string;
  environment?: Record<string, string>;
  volumes?: string[];
  networks?: string[];
  ports?: string[];
  profiles?: string[];
}
interface LocalModel {
  name: string;
  services: Record<'postgres' | 'redis' | 'api' | 'web' | 'setup' | 'migrator', LocalService>;
  networks: {
    data: { internal: boolean; labels: Record<string, string> };
    install: { labels: Record<string, string> };
  };
  volumes: Record<string, { labels: Record<string, string> }>;
}
export function projectFor(root: string): string;
export function validateEndpoint(context: string, endpoint: string): void;
export function assertOwned(items: unknown[], root: string, project: string, kind: string): void;
export function makeModel(
  base: unknown,
  root: string,
  nodeImage: string,
  lock: unknown,
): LocalModel;
export function main(args?: string[]): Promise<void>;
export function atomicJson(path: string, value: unknown): void;
export function previewReady(containers: unknown[], initialized: unknown): boolean;
export function assertResumeVolumes(expected: unknown, observed: unknown[]): void;
export function atomicPrivateFile(path: string, content: string): void;
export function finishOperation(guard: string, uncertain: boolean): void;
export function assertPrivatePath(path: string, directory?: boolean): void;
export function uncertainCompletion(result: {
  signal?: string | null;
  status?: number | null;
  error?: { code?: string };
}): boolean;
