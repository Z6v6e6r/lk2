import { describe, it, expect, vi } from 'vitest';
import { LegacyTournamentSummaryAdapter } from './index.js';
const source = {
  id: 'synthetic-custom',
  name: 'Synthetic tournament',
  rawStatus: 'REGISTRATION',
  isPublic: true,
  startsAt: '2026-11-01T00:30:00+03:00',
  endsAt: '2026-11-01T01:30:00+03:00',
  studioId: 'synthetic-studio',
  maxPlayers: 8,
  participantsCount: 1,
  waitlistCount: 0,
};
describe('original tournament dated feed association', () => {
  it('pins feed query date rather than normalized UTC date', async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(Response.json([source])));
    const adapter = new LegacyTournamentSummaryAdapter({ fetchImplementation });
    const [summary] = await adapter.readDate('2026-11-01');
    expect(summary!.startsAt.slice(0, 10)).toBe('2026-10-31');
    expect(await adapter.resolveRegistrationDate(summary!.id)).toBe('2026-11-01');
    const url = fetchImplementation.mock.calls[1]![0];
    expect(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url).toContain(
      'date=2026-11-01',
    );
  });
  it('missing, disappeared and ambiguous date never become provider fallback', async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(Response.json([source])));
    const adapter = new LegacyTournamentSummaryAdapter({ fetchImplementation });
    await expect(adapter.resolveRegistrationDate('missing')).rejects.toThrow();
    expect(fetchImplementation).not.toHaveBeenCalled();
    const [s] = await adapter.readDate('2026-11-01');
    fetchImplementation.mockImplementationOnce(() => Promise.resolve(Response.json([])));
    await expect(adapter.resolveRegistrationDate(s!.id)).rejects.toThrow();
    await adapter.readDate('2026-11-02');
    await expect(adapter.resolveRegistrationDate(s!.id)).rejects.toThrow();
  });
});
