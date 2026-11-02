export const R1_TAIL_LOCKS: readonly string[];
export interface R1LockIO {
  present(path: string): boolean;
  read(path: string): Buffer;
  rawRead(path: string): Buffer;
  info(path: string): { dev: number; ino: number; nlink: number };
  stage(target: string, bytes: Buffer): string;
  durable(path: string, bytes: Buffer, exclusive: boolean): void;
  link(from: string, to: string): void;
  unlink(path: string): void;
  syncParent(path: string): void;
  normalize(path: string): void;
}
export interface R1LockCustody {
  load(): unknown;
  claim(live: () => void): void;
  assert(full: boolean): boolean;
  release(): void;
}
export function createR1TailLockCustody(
  root: string,
  marker: Buffer,
  owner: { assertOwned: () => void },
  io: R1LockIO,
): R1LockCustody;
