import { describe, expect, it } from 'vitest';
import { createCommunityReadExperienceService } from './community-read-experience.js';

const base = {
  tenantId: 'a',
  viewerUserId: 'b',
  communityId: '11111111-1111-4111-8111-111111111111',
  correlationId: 'c',
};
describe('CommunityReadExperienceService', () => {
  it('accepts only the source-neutral read-only projection and bounded pages', async () => {
    const service = createCommunityReadExperienceService({
      getDetail: () =>
        Promise.resolve({
          id: base.communityId,
          title: 'Padel',
          logoUrl: null,
          isVerified: true,
          description: null,
          memberCount: 1,
          readOnly: true,
        }),
      getFeed: () =>
        Promise.resolve({
          items: [
            {
              kind: 'SYSTEM',
              title: 'Hello',
              body: '',
              publishedAt: '2026-08-11T10:00:00.000Z',
              author: { displayName: 'A' },
            },
          ],
        }),
      getChat: () =>
        Promise.resolve({
          items: [
            {
              body: 'Hi',
              sentAt: '2026-08-11T10:00:00.000Z',
              author: { displayName: 'A' },
              isViewer: true,
            },
          ],
        }),
      getRating: () =>
        Promise.resolve({
          period: 'all',
          tab: 'overall',
          calculationVersion: 'community-rating-v1.3.0',
          rows: [
            {
              place: 1,
              displayName: 'A',
              currentLevel: 1,
              score: 2,
              delta: 0,
              games: 3,
              tournaments: 4,
            },
          ],
        }),
    });
    await expect(service.getFeed({ ...base, limit: 50 })).resolves.toMatchObject({
      items: [{ title: 'Hello' }],
    });
    await expect(service.getChat({ ...base, limit: 51 })).rejects.toMatchObject({
      code: 'COMMUNITY_EXPERIENCE_INVALID',
    });
  });
  it('rejects leaked source identifiers and provider-shaped payloads', async () => {
    const service = createCommunityReadExperienceService({
      getDetail: () =>
        Promise.resolve({
          id: base.communityId,
          title: 'Padel',
          logoUrl: null,
          isVerified: true,
          description: null,
          memberCount: 1,
          readOnly: true,
          phone: '7999',
        }),
      getFeed: () => Promise.resolve({ items: [] }),
      getChat: () => Promise.resolve({ items: [] }),
      getRating: () => Promise.resolve({}),
    });
    await expect(service.getDetail(base)).rejects.toMatchObject({
      code: 'COMMUNITY_EXPERIENCE_INVALID',
    });
  });
});
