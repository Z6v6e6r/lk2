import type { LocationProfileChangedEvent } from '@phub/locations';
import { describe, expect, it, vi } from 'vitest';

import { fanOutLocationHomeComponent } from './location-home-projector.js';

const event: LocationProfileChangedEvent = {
  id: '11111111-1111-4111-8111-111111111111',
  type: 'locations.profile.changed.v1',
  aggregateId: '22222222-2222-4222-8222-222222222222',
  tenantId: '86afbe01-0318-4dd2-bc25-303b7bf0d430',
  occurredAt: '2026-07-17T12:00:00.000Z',
  correlationId: 'location-home-test-1234',
  payload: {
    locationId: '22222222-2222-4222-8222-222222222222',
    componentRevision: '8',
  },
};

describe('location Home projection fan-out', () => {
  it('queues one strict locations component for every existing Home user', async () => {
    const query = vi.fn((...args: [text: string, params?: readonly unknown[]]) => {
      const [text] = args;
      if (
        text === 'begin' ||
        text === 'commit' ||
        text === 'rollback' ||
        text.includes("set_config('app.tenant_id'") ||
        text.includes('pg_advisory_xact_lock') ||
        text.includes('update audit.inbox_events')
      ) {
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      if (text.includes('insert into audit.inbox_events')) {
        return Promise.resolve({ rows: [{ event_id: event.id }], rowCount: 1 });
      }
      if (text.includes('from locations.profiles')) {
        return Promise.resolve({
          rows: [
            {
              id: event.aggregateId,
              title: 'Хаб Нагатинская',
              short_title: 'Нагатинская',
              court_count: 6,
              gallery: [
                {
                  url: 'https://cdn.padlhub.test/location.webp',
                  alt: '',
                  isCover: true,
                  sortOrder: 0,
                },
              ],
            },
          ],
          rowCount: 1,
        });
      }
      if (text.includes('from home.dashboard_components')) {
        return Promise.resolve({
          rows: [{ user_id: '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca' }],
          rowCount: 1,
        });
      }
      if (text.includes('insert into audit.outbox_events')) {
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const release = vi.fn();
    const pool = { connect: vi.fn().mockResolvedValue({ query, release }) };

    await expect(fanOutLocationHomeComponent({ pool: pool as never, event })).resolves.toEqual({
      outcome: 'queued',
      userCount: 1,
      locationCount: 1,
    });

    const fanoutCall = query.mock.calls.find(([text]) =>
      String(text).includes('insert into audit.outbox_events'),
    );
    expect(fanoutCall?.[1]).toContain('8');
    expect(JSON.stringify(fanoutCall?.[1])).not.toContain('stationId');
    expect(release).toHaveBeenCalledOnce();
  });
});
