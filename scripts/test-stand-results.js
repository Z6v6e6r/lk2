// Pure helpers for scripts/test-stand-results-e2e.js (kept separate so they can be unit-tested
// without signing in to a stand).

export const ALLOWED_HOSTS = new Set(['test.lk2.padlhub.su', 'localhost', '127.0.0.1', '[::1]']);

// Join closes 30 minutes before the start (game-routes CREATE sets joinCutoffAt), so the start
// leaves a margin for the three joins after the cutoff rule.
export const START_LEAD_MINUTES = 32;
export const DEFAULT_DURATION_MINUTES = 5;
// Lifecycle FINISHED is applied by the Worker at endsAt; give it a short grace period.
export const FINISH_GRACE_MS = 60_000;

export function standHostAllowed(baseUrl) {
  let host;
  try {
    host = new URL(baseUrl).host.replace(/:\d+$/, '');
  } catch {
    return false;
  }
  return ALLOWED_HOSTS.has(host);
}

export function parseArgs(argv) {
  const args = { phase: 'all', gameId: undefined, durationMinutes: DEFAULT_DURATION_MINUTES };
  for (const arg of argv) {
    const [key, value] = arg.replace(/^--/, '').split('=', 2);
    if (key === 'phase' && ['prepare', 'verify', 'all'].includes(value)) args.phase = value;
    else if (key === 'game' && /^[0-9a-f-]{36}$/i.test(value ?? '')) args.gameId = value;
    else if (key === 'duration' && /^\d+$/.test(value ?? '') && Number(value) >= 1)
      args.durationMinutes = Math.min(Number(value), 90);
    else throw new Error(`Unknown or invalid argument: ${arg}`);
  }
  return args;
}

export function resultGameSchedule(nowMs, durationMinutes = DEFAULT_DURATION_MINUTES) {
  const start = new Date(nowMs + START_LEAD_MINUTES * 60_000);
  // Round up to the next whole minute so the slot reads cleanly in the UI.
  if (start.getUTCSeconds() || start.getUTCMilliseconds()) {
    start.setUTCSeconds(0, 0);
    start.setUTCMinutes(start.getUTCMinutes() + 1);
  }
  const end = new Date(start.getTime() + durationMinutes * 60_000);
  return {
    startsAt: start.toISOString(),
    endsAt: end.toISOString(),
    verifyAfter: new Date(end.getTime() + FINISH_GRACE_MS).toISOString(),
  };
}

// scores: [[teamA, teamB], ...]; the same pairs play every set.
export function resultSubmission(teamAUserIds, teamBUserIds, scores) {
  return {
    sets: scores.map(([teamA, teamB], index) => ({
      setNumber: index + 1,
      teamAUserIds: [...teamAUserIds],
      teamBUserIds: [...teamBUserIds],
      teamA,
      teamB,
    })),
  };
}
