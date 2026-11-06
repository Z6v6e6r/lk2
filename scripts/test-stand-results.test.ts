import { describe, expect, it } from 'vitest';
import { submitGameResultInputSchema } from '@phub/games';
import {
  parseArgs,
  resultGameSchedule,
  resultSubmission,
  standHostAllowed,
  START_LEAD_MINUTES,
} from './test-stand-results.js';

describe('stand results e2e helpers', () => {
  it('runs only on the stand or localhost', () => {
    expect(standHostAllowed('https://test.lk2.padlhub.su')).toBe(true);
    expect(standHostAllowed('http://127.0.0.1:3000')).toBe(true);
    expect(standHostAllowed('https://lk2.padlhub.su')).toBe(false);
    expect(standHostAllowed('https://test.lk2.padlhub.su.evil.example')).toBe(false);
    expect(standHostAllowed('not a url')).toBe(false);
  });

  it('schedules the game after the 30-minute join cutoff and on a whole minute', () => {
    const now = Date.parse('2026-11-06T10:00:30.500Z');
    const schedule = resultGameSchedule(now, 5);
    const start = Date.parse(schedule.startsAt);
    expect(start - 30 * 60_000).toBeGreaterThan(now);
    expect(start - now).toBeGreaterThanOrEqual(START_LEAD_MINUTES * 60_000);
    expect(new Date(start).getUTCSeconds()).toBe(0);
    expect(Date.parse(schedule.endsAt) - start).toBe(5 * 60_000);
    expect(Date.parse(schedule.verifyAfter)).toBeGreaterThan(Date.parse(schedule.endsAt));
  });

  it('builds a submission the server schema accepts', () => {
    const ids = [
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
      '00000000-0000-4000-8000-000000000003',
      '00000000-0000-4000-8000-000000000004',
    ];
    const body = resultSubmission(ids.slice(0, 2), ids.slice(2), [
      [6, 4],
      [3, 6],
      [7, 5],
    ]);
    expect(submitGameResultInputSchema.safeParse(body).success).toBe(true);
    expect(body.sets.map((set) => set.setNumber)).toEqual([1, 2, 3]);
  });

  it('parses phases and rejects unknown arguments', () => {
    expect(parseArgs([])).toMatchObject({ phase: 'all', durationMinutes: 5 });
    expect(
      parseArgs(['--phase=verify', '--game=00000000-0000-4000-8000-000000000001']),
    ).toMatchObject({ phase: 'verify', gameId: '00000000-0000-4000-8000-000000000001' });
    expect(parseArgs(['--duration=200']).durationMinutes).toBe(90);
    expect(() => parseArgs(['--phase=apply'])).toThrow();
    expect(() => parseArgs(['--target=lk2'])).toThrow();
  });
});
