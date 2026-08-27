export class TimewebFrozenSourceError extends Error {
  readonly reason: string;
}

export type TimewebFrozenSourceAuthority = {
  readonly sourceSha: string;
  readonly sourceTree: string;
  readonly __exactTimewebFrozenSourceAuthority: unique symbol;
};

export function validateTimewebFrozenSourceObservation(
  observation: {
    repositoryRoot: string;
    repositoryRootSecure: boolean;
    protectedFilesSecure: boolean;
    gitDirectorySecure: boolean;
    topLevel: string;
    head: string;
    tree: string;
    status: string;
  },
  expected: { sourceSha: string; sourceTree: string },
): void;

export function assertExactTimewebFrozenSource(options: {
  expectedSourceSha: string;
  expectedSourceTree: string;
}): TimewebFrozenSourceAuthority;

export function requireExactTimewebFrozenSourceAuthority(
  authority: TimewebFrozenSourceAuthority,
  expected: { sourceSha: string; sourceTree: string },
): void;
