export declare const ALLOWED_HOSTS: ReadonlySet<string>;
export declare const START_LEAD_MINUTES: number;
export declare const DEFAULT_DURATION_MINUTES: number;
export declare const FINISH_GRACE_MS: number;
export declare function standHostAllowed(baseUrl: string): boolean;
export declare function parseArgs(argv: readonly string[]): {
  phase: 'prepare' | 'verify' | 'all';
  gameId: string | undefined;
  durationMinutes: number;
};
export declare function resultGameSchedule(
  nowMs: number,
  durationMinutes?: number,
): { startsAt: string; endsAt: string; verifyAfter: string };
export declare function resultSubmission(
  teamAUserIds: readonly string[],
  teamBUserIds: readonly string[],
  scores: ReadonlyArray<readonly [number, number]>,
): {
  sets: Array<{
    setNumber: number;
    teamAUserIds: string[];
    teamBUserIds: string[];
    teamA: number;
    teamB: number;
  }>;
};
