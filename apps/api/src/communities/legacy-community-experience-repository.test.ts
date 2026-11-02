import { describe, expect, it, vi } from 'vitest';
import { LegacyCommunityExperienceRepository } from './legacy-community-experience-repository.js';
const communityId = '11111111-1111-4111-8111-111111111111';
const input = {
  tenantId: 'tenant',
  viewerUserId: 'viewer',
  communityId,
  correlationId: 'correlation',
};
function fetchUrl(value: Parameters<typeof fetch>[0]): URL {
  if (value instanceof URL) return value;
  if (value instanceof Request) return new URL(value.url);
  return new URL(value);
}
const bridge = () => ({
  getCommunityExternalId: () => Promise.resolve('legacy-community'),
  getViewerIdentity: () =>
    Promise.resolve({ clientId: 'legacy-viewer', phoneE164: '+79990000001' }),
  resolveCommunityIds: () => Promise.resolve(new Map()),
});
const detail = {
  name: 'Legacy Padel',
  description: 'Description',
  isVerified: true,
  members: [{ id: 'legacy-viewer', status: 'ACTIVE' }],
};
const summary = {
  communities: [
    {
      id: 'legacy-community',
      name: 'Legacy Padel',
      description: 'Description',
      isVerified: true,
      members: [{ id: 'legacy-viewer', status: 'ACTIVE' }],
    },
  ],
};
function repository(
  fetchImplementation: typeof fetch,
  bridgeImplementation: ConstructorParameters<
    typeof LegacyCommunityExperienceRepository
  >[0]['bridge'] = bridge(),
) {
  return new LegacyCommunityExperienceRepository({
    baseUrl: 'https://legacy.test',
    timeoutMs: 1_000,
    maxAttempts: 2,
    circuitFailureThreshold: 3,
    circuitResetMs: 30_000,
    bridge: bridgeImplementation,
    fetchImplementation,
  });
}

function oversizedChunkedResponse(): Response {
  const chunk = new Uint8Array(1024 * 1024 + 1);
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(chunk);
        controller.enqueue(chunk);
        controller.close();
      },
    }),
    { status: 200 },
  );
}
describe('legacy community experience repository', () => {
  it('fails closed while streaming a chunked provider response beyond the byte limit', async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(oversizedChunkedResponse()));

    await expect(repository(fetchImplementation).getDetail(input)).rejects.toMatchObject({
      code: 'COMMUNITY_EXPERIENCE_PROVIDER_INVALID',
      diagnostic: 'provider-body-bytes',
    });
  });

  it('revalidates ACTIVE membership and strips source identities', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockImplementation((url) => {
      const path = fetchUrl(url).pathname;
      return Promise.resolve(
        new Response(
          JSON.stringify(
            path === '/lk/communities'
              ? summary
              : path.endsWith('/feed')
                ? {
                    posts: [
                      {
                        id: 'legacy-post-1',
                        kind: 'PHOTO',
                        title: 'Photo',
                        body: 'Text',
                        publishedAt: '2026-08-11T10:00:00.000Z',
                        authorName: 'Author',
                        authorId: 'legacy-author',
                        authorPhone: '79990000002',
                      },
                    ],
                    nextBeforeTs: 1_786_444_800_000,
                  }
                : detail,
          ),
          { status: 200 },
        ),
      );
    });
    const subject = repository(fetchImplementation);
    const first = await subject.getFeed({ ...input, limit: 1 });
    const second = await subject.getFeed({
      ...input,
      limit: 1,
      ...(first.nextCursor ? { cursor: first.nextCursor } : {}),
    });
    expect(fetchUrl(fetchImplementation.mock.calls[0]![0]).href).toContain(
      '/lk/communities?view=summary',
    );
    expect(fetchUrl(fetchImplementation.mock.calls[0]![0]).href).toContain('phone=79990000001');
    expect(fetchUrl(fetchImplementation.mock.calls[0]![0]).href).toContain(
      'clientId=legacy-viewer',
    );
    expect(fetchUrl(fetchImplementation.mock.calls[1]![0]).href).toContain(
      '/lk/communities/legacy-community/feed',
    );
    expect(fetchUrl(fetchImplementation.mock.calls[1]![0]).href).toContain('limit=1');
    expect(
      fetchImplementation.mock.calls.some(([value]) =>
        fetchUrl(value).href.includes('beforeTs=1786444800000'),
      ),
    ).toBe(true);
    expect(first.items[0]).toEqual(second.items[0]);
    expect(JSON.stringify(first)).not.toContain('legacy-post-1');
    expect(JSON.stringify(first)).not.toContain('79990000002');
    expect(JSON.stringify(first)).not.toContain('legacy-author');
    expect(fetchImplementation.mock.calls[1]?.[1]).toMatchObject({
      redirect: 'error',
      headers: { Accept: 'application/json', 'X-Correlation-ID': 'correlation' },
    });
  });
  it('uses messages and exact rating version while recognising flat viewer fields', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockImplementation((url) => {
      const path = fetchUrl(url).pathname;
      if (path.endsWith('/messages'))
        return Promise.resolve(
          new Response(
            JSON.stringify({
              messages: [
                {
                  id: 'legacy-message-1',
                  text: 'Hi',
                  createdAt: '2026-08-11T10:00:00.000Z',
                  authorName: 'Viewer',
                  authorId: 'legacy-viewer',
                  authorPhone: '79990000001',
                },
              ],
            }),
            { status: 200 },
          ),
        );
      if (path.endsWith('/rating'))
        return Promise.resolve(
          new Response(
            JSON.stringify({
              calculationVersion: 'community-rating-v1.3.0',
              items: [
                {
                  playerId: 'player-1',
                  playerName: 'Player',
                  currentLevel: null,
                  overallScore: '2.5',
                  levelDelta: 0,
                  gamesPlayed: 3,
                  tournamentsPlayed: 4,
                },
              ],
            }),
            { status: 200 },
          ),
        );
      return Promise.resolve(
        new Response(JSON.stringify(path === '/lk/communities' ? summary : detail), {
          status: 200,
        }),
      );
    });
    const subject = repository(fetchImplementation);
    await expect(subject.getChat({ ...input, limit: 1 })).resolves.toMatchObject({
      items: [{ isViewer: true, author: { displayName: 'Viewer' } }],
    });
    await expect(
      subject.getRating({ ...input, period: 'all', tab: 'dynamics' }),
    ).resolves.toMatchObject({
      calculationVersion: 'community-rating-v1.3.0',
      tab: 'dynamics',
      rows: [{ place: 1, currentLevel: 0, score: 2.5 }],
    });
    expect(
      fetchImplementation.mock.calls.some(([value]) => fetchUrl(value).href.includes('/messages')),
    ).toBe(true);
    expect(
      fetchImplementation.mock.calls.some(([value]) => fetchUrl(value).href.includes('tab=level')),
    ).toBe(true);
    const capped = repository(
      vi.fn<typeof fetch>().mockImplementation((url) => {
        const path = fetchUrl(url).pathname;
        return Promise.resolve(
          new Response(
            JSON.stringify(
              path.endsWith('/rating')
                ? {
                    calculationVersion: 'community-rating-v1.3.0',
                    rows: Array.from({ length: 101 }, (_, index) => ({
                      rank: index + 1,
                      playerName: `Player ${index + 1}`,
                      currentLevel: 1,
                      overallScore: 2,
                    })),
                  }
                : path === '/lk/communities'
                  ? summary
                  : detail,
            ),
            { status: 200 },
          ),
        );
      }),
    );
    const cappedRating = await capped.getRating({ ...input, period: '30d', tab: 'overall' });
    expect(cappedRating.rows).toHaveLength(100);
    expect(cappedRating.rows[0]).toMatchObject({ place: 1 });

    const fullSnapshot = repository(
      vi.fn<typeof fetch>().mockImplementation((url) => {
        const path = fetchUrl(url).pathname;
        return Promise.resolve(
          new Response(
            JSON.stringify(
              path.endsWith('/rating')
                ? {
                    calculationVersion: 'community-rating-v1.3.0',
                    rows: Array.from({ length: 101 }, (_, index) => ({
                      rank: index + 1,
                      playerName: `Player ${index + 1}`,
                      currentLevel: 1,
                      overallScore: 2,
                      ignoredLegacySnapshotData: 'x'.repeat(21_000),
                    })),
                  }
                : path === '/lk/communities'
                  ? summary
                  : detail,
            ),
            { status: 200 },
          ),
        );
      }),
    );
    const fullSnapshotRating = await fullSnapshot.getRating({
      ...input,
      period: 'all',
      tab: 'overall',
    });
    expect(fullSnapshotRating.rows).toHaveLength(100);
    expect(fullSnapshotRating.rows.at(-1)).toMatchObject({ place: 100 });
    const wrong = repository(
      vi
        .fn<typeof fetch>()
        .mockImplementation((url) =>
          Promise.resolve(
            new Response(
              JSON.stringify(
                fetchUrl(url).pathname.endsWith('/rating')
                  ? { calculationVersion: 'wrong', rows: [] }
                  : fetchUrl(url).pathname === '/lk/communities'
                    ? summary
                    : detail,
              ),
              { status: 200 },
            ),
          ),
        ),
    );
    await expect(
      wrong.getRating({ ...input, period: 'all', tab: 'overall' }),
    ).rejects.toMatchObject({ code: 'COMMUNITY_EXPERIENCE_VERSION_UNAVAILABLE' });

    const fallbackFetch = vi.fn<typeof fetch>().mockImplementation((url) => {
      const path = fetchUrl(url).pathname;
      if (path.endsWith('/rating')) return Promise.resolve(new Response('{}', { status: 404 }));
      if (path.endsWith('/ranking'))
        return Promise.resolve(
          new Response(
            JSON.stringify({
              calculationVersion: 'community-rating-v1.3.0',
              rows: [
                {
                  rank: 1,
                  playerName: 'Player',
                  currentLevel: 1,
                  overallScore: 2,
                  gamesPlayed: 3,
                  tournamentsPlayed: 4,
                },
              ],
            }),
            { status: 200 },
          ),
        );
      if (path === '/lk/communities')
        return Promise.resolve(
          new Response(JSON.stringify({ communities: [{ id: 'legacy-community', ...detail }] }), {
            status: 200,
          }),
        );
      return Promise.resolve(new Response(JSON.stringify(detail), { status: 200 }));
    });
    await expect(
      repository(fallbackFetch).getRating({ ...input, period: '30d', tab: 'dynamics' }),
    ).resolves.toMatchObject({ rows: [{ displayName: 'Player', score: 2 }] });
    expect(
      fallbackFetch.mock.calls.some(([value]) => fetchUrl(value).href.includes('/ranking')),
    ).toBe(true);
  });
  it('fails closed for inactive membership, oversized response, and malformed provider data', async () => {
    const inactive = repository(
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            communities: [
              { id: 'legacy-community', members: [{ id: 'legacy-viewer', status: 'LEFT' }] },
            ],
          }),
          { status: 200 },
        ),
      ),
    );
    await expect(inactive.getDetail(input)).rejects.toMatchObject({
      code: 'COMMUNITY_EXPERIENCE_FORBIDDEN',
    });
    const oversized = repository(
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response('{}', {
          status: 200,
          headers: { 'content-length': String(2 * 1024 * 1024 + 1) },
        }),
      ),
    );
    await expect(oversized.getDetail(input)).rejects.toMatchObject({
      code: 'COMMUNITY_EXPERIENCE_PROVIDER_INVALID',
      diagnostic: 'provider-content-length',
    });
    const malformed = repository(
      vi.fn<typeof fetch>().mockImplementation((url) =>
        Promise.resolve(
          new Response(
            JSON.stringify(
              fetchUrl(url).pathname === '/lk/communities'
                ? {
                    communities: [{ ...summary.communities[0], name: 'x', memberCount: -1 }],
                  }
                : detail,
            ),
            { status: 200 },
          ),
        ),
      ),
    );
    await expect(malformed.getDetail(input)).rejects.toMatchObject({
      code: 'COMMUNITY_EXPERIENCE_PROVIDER_INVALID',
      diagnostic: 'detail-member-count',
    });
  });

  it('retries a transport failure while reading an HTTP 200 response body', async () => {
    let feedAttempts = 0;
    const fetchImplementation = vi.fn<typeof fetch>().mockImplementation((url) => {
      const path = fetchUrl(url).pathname;
      if (path === '/lk/communities')
        return Promise.resolve(new Response(JSON.stringify(summary), { status: 200 }));
      if (path.endsWith('/feed')) {
        feedAttempts += 1;
        if (feedAttempts === 1) {
          return Promise.resolve(
            new Response(
              new ReadableStream({
                pull() {
                  throw new DOMException('aborted', 'AbortError');
                },
              }),
              { status: 200 },
            ),
          );
        }
        return Promise.resolve(
          new Response(JSON.stringify({ posts: [], nextBeforeTs: 0 }), { status: 200 }),
        );
      }
      return Promise.resolve(new Response(JSON.stringify(detail), { status: 200 }));
    });

    await expect(repository(fetchImplementation).getFeed({ ...input, limit: 1 })).resolves.toEqual({
      items: [],
    });
    expect(feedAttempts).toBe(2);
  });

  it('normalizes member phones and rejects out-of-range provider cursors', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockImplementation((url) => {
      const path = fetchUrl(url).pathname;
      return Promise.resolve(
        new Response(
          JSON.stringify(
            path === '/lk/communities'
              ? {
                  communities: [
                    {
                      id: 'legacy-community',
                      name: 'Legacy Padel',
                      members: [{ phone: '89990000001', status: 'ACTIVE' }],
                    },
                  ],
                }
              : path.endsWith('/feed')
                ? { posts: [], nextBeforeTs: 9_000_000_000_000_000 }
                : detail,
          ),
          { status: 200 },
        ),
      );
    });
    const subject = repository(fetchImplementation, {
      getCommunityExternalId: () => Promise.resolve('legacy-community'),
      getViewerIdentity: () => Promise.resolve({ phoneE164: '+79990000001' }),
      resolveCommunityIds: () => Promise.resolve(new Map()),
    });
    await expect(subject.getDetail(input)).resolves.toMatchObject({ title: 'Legacy Padel' });
    await expect(subject.getFeed({ ...input, limit: 1 })).rejects.toMatchObject({
      code: 'COMMUNITY_EXPERIENCE_PROVIDER_INVALID',
      diagnostic: 'page-next-before-ts',
    });
  });

  it('treats zero and null provider cursors as terminal pages', async () => {
    for (const nextBeforeTs of [0, null]) {
      const fetchImplementation = vi.fn<typeof fetch>().mockImplementation((url) => {
        const path = fetchUrl(url).pathname;
        return Promise.resolve(
          new Response(
            JSON.stringify(
              path === '/lk/communities'
                ? summary
                : path.endsWith('/feed')
                  ? { posts: [], nextBeforeTs }
                  : detail,
            ),
            { status: 200 },
          ),
        );
      });

      await expect(
        repository(fetchImplementation).getFeed({ ...input, limit: 1 }),
      ).resolves.toEqual({ items: [] });
    }
  });

  it('rejects present nonnumeric provider cursors', async () => {
    for (const nextBeforeTs of ['invalid']) {
      const fetchImplementation = vi.fn<typeof fetch>().mockImplementation((url) => {
        const path = fetchUrl(url).pathname;
        return Promise.resolve(
          new Response(
            JSON.stringify(
              path === '/lk/communities'
                ? summary
                : path.endsWith('/feed')
                  ? { posts: [], nextBeforeTs }
                  : detail,
            ),
            { status: 200 },
          ),
        );
      });

      await expect(
        repository(fetchImplementation).getFeed({ ...input, limit: 1 }),
      ).rejects.toMatchObject({
        code: 'COMMUNITY_EXPERIENCE_PROVIDER_INVALID',
        diagnostic: 'page-next-before-ts',
      });
    }
  });

  it('derives a gap-free cursor for terminal and nonterminal provider oversend', async () => {
    const firstPost = {
      id: 'legacy-post-1',
      kind: 'PHOTO',
      body: 'First',
      publishedAt: '2026-08-11T10:00:00.000Z',
      authorName: 'Author',
    };
    const secondPost = {
      ...firstPost,
      id: 'legacy-post-2',
      body: 'Second',
      publishedAt: '2026-08-11T09:00:00.000Z',
    };
    for (const providerNextBeforeTs of [0, Date.parse('2026-08-11T08:00:00.000Z')]) {
      const fetchImplementation = vi.fn<typeof fetch>().mockImplementation((url) => {
        const path = fetchUrl(url).pathname;
        const beforeTs = fetchUrl(url).searchParams.get('beforeTs');
        return Promise.resolve(
          new Response(
            JSON.stringify(
              path === '/lk/communities'
                ? summary
                : path.endsWith('/feed')
                  ? {
                      posts: beforeTs ? [secondPost] : [firstPost, secondPost],
                      nextBeforeTs: beforeTs ? 0 : providerNextBeforeTs,
                    }
                  : detail,
            ),
            { status: 200 },
          ),
        );
      });

      const subject = repository(fetchImplementation);
      const first = await subject.getFeed({ ...input, limit: 1 });
      expect(first).toMatchObject({ items: [{ body: 'First' }] });
      expect(first.nextCursor).toBeDefined();
      const second = await subject.getFeed({
        ...input,
        limit: 1,
        ...(first.nextCursor ? { cursor: first.nextCursor } : {}),
      });
      expect(second).toMatchObject({ items: [{ body: 'Second' }] });
      expect(
        fetchImplementation.mock.calls.some(
          ([value]) =>
            fetchUrl(value).searchParams.get('beforeTs') ===
            String(Date.parse(firstPost.publishedAt)),
        ),
      ).toBe(true);
    }
  });

  it('rejects tied or unsorted provider oversend timestamps', async () => {
    const firstPost = {
      id: 'legacy-post-1',
      kind: 'PHOTO',
      body: 'First',
      publishedAt: '2026-08-11T10:00:00.000Z',
      authorName: 'Author',
    };
    for (const secondTimestamp of [firstPost.publishedAt, '2026-08-11T11:00:00.000Z']) {
      const fetchImplementation = vi.fn<typeof fetch>().mockImplementation((url) => {
        const path = fetchUrl(url).pathname;
        return Promise.resolve(
          new Response(
            JSON.stringify(
              path === '/lk/communities'
                ? summary
                : path.endsWith('/feed')
                  ? {
                      posts: [
                        firstPost,
                        {
                          ...firstPost,
                          id: 'legacy-post-2',
                          publishedAt: secondTimestamp,
                        },
                      ],
                      nextBeforeTs: 0,
                    }
                  : detail,
            ),
            { status: 200 },
          ),
        );
      });

      await expect(
        repository(fetchImplementation).getFeed({ ...input, limit: 1 }),
      ).rejects.toMatchObject({
        code: 'COMMUNITY_EXPERIENCE_PROVIDER_INVALID',
        diagnostic: 'page-oversend-order',
      });
    }
  });

  it('derives a gap-free chat cursor for bounded oversend', async () => {
    const firstMessage = {
      id: 'legacy-message-1',
      body: 'First',
      sentAt: '2026-08-11T10:00:00.000Z',
      authorName: 'Author',
    };
    const secondMessage = {
      ...firstMessage,
      id: 'legacy-message-2',
      body: 'Second',
      sentAt: '2026-08-11T09:00:00.000Z',
    };
    const fetchImplementation = vi.fn<typeof fetch>().mockImplementation((url) => {
      const path = fetchUrl(url).pathname;
      const beforeTs = fetchUrl(url).searchParams.get('beforeTs');
      return Promise.resolve(
        new Response(
          JSON.stringify(
            path === '/lk/communities'
              ? summary
              : path.endsWith('/messages')
                ? {
                    messages: beforeTs ? [secondMessage] : [firstMessage, secondMessage],
                    nextBeforeTs: 0,
                  }
                : detail,
          ),
          { status: 200 },
        ),
      );
    });

    const subject = repository(fetchImplementation);
    const first = await subject.getChat({ ...input, limit: 1 });
    const second = await subject.getChat({
      ...input,
      limit: 1,
      ...(first.nextCursor ? { cursor: first.nextCursor } : {}),
    });
    expect(first).toMatchObject({ items: [{ body: 'First' }] });
    expect(second).toMatchObject({ items: [{ body: 'Second' }] });
  });
});

it('authenticates each session without cross-session coalescing, preserves canonical UUID and only STATION eligibility', async () => {
  const token = vi.fn((actor: { sessionId: string }) =>
    Promise.resolve(`token-${actor.sessionId}`),
  );
  const fetchImplementation = vi.fn<typeof fetch>((url, init) => {
    expect(new Headers(init?.headers).get('Authorization')).toMatch(/^Bearer token-session[12]$/);
    if (fetchUrl(url).pathname.endsWith('/messages')) {
      expect(Object.fromEntries(fetchUrl(url).searchParams)).toEqual({
        historyVersion: '2',
        limit: '50',
      });
    }
    return Promise.resolve(
      Response.json(
        fetchUrl(url).toString().includes('view=summary')
          ? { communities: [{ ...summary.communities[0], communityType: 'STATION' }] }
          : {
              historyVersion: 2,
              nextBefore: null,
              hasMore: false,
              messages: [
                {
                  publicId: '22222222-2222-8222-8222-222222222222',
                  text: 'hello',
                  createdAt: '2026-11-01T00:00:00.000Z',
                  createdTs: Date.parse('2026-11-01T00:00:00.000Z'),
                  authorId: 'legacy-viewer',
                  authorName: 'Player',
                },
              ],
            },
      ),
    );
  });
  const repo = new LegacyCommunityExperienceRepository({
    baseUrl: 'https://legacy.test',
    timeoutMs: 1000,
    maxAttempts: 1,
    circuitFailureThreshold: 3,
    circuitResetMs: 1000,
    bridge: bridge(),
    fetchImplementation,
    token,
    stationMessageRequests: true,
  });
  const pages = await Promise.all(
    ['session1', 'session2'].map((sessionId) =>
      repo.getChat({ ...input, tenantKey: 'test', sessionId, limit: 50 }),
    ),
  );
  expect(JSON.stringify(pages)).not.toContain('legacy-viewer');
  expect(token).toHaveBeenCalledTimes(2);
  expect(fetchImplementation).toHaveBeenCalledTimes(4);
  expect(pages[0]).toMatchObject({
    canRequestStationMessage: true,
    items: [{ id: '22222222-2222-8222-8222-222222222222', isViewer: true }],
  });
  await expect(repo.getChat({ ...input, limit: 50 })).rejects.toMatchObject({
    code: 'COMMUNITY_EXPERIENCE_FORBIDDEN',
  });
  token.mockRejectedValueOnce(new Error('revoked'));
  await expect(
    repo.getChat({ ...input, tenantKey: 'test', sessionId: 'session1', limit: 50 }),
  ).rejects.toMatchObject({ code: 'COMMUNITY_EXPERIENCE_FORBIDDEN' });
  expect(fetchImplementation).toHaveBeenCalledTimes(4);
});

it.each([401, 403, 404])(
  'three actor history %i denials do not block a different session',
  async (status) => {
    let allowed = false;
    const token = vi.fn(({ sessionId }: { sessionId: string }) =>
      Promise.resolve(`synthetic-${sessionId}`),
    );
    const fetchImplementation = vi.fn<typeof fetch>((url) =>
      Promise.resolve(
        fetchUrl(url).searchParams.has('view')
          ? Response.json(summary)
          : allowed
            ? Response.json({ messages: [] })
            : new Response(null, { status }),
      ),
    );
    const repo = new LegacyCommunityExperienceRepository({
      baseUrl: 'https://legacy.test',
      timeoutMs: 1000,
      maxAttempts: 1,
      circuitFailureThreshold: 3,
      circuitResetMs: 30000,
      bridge: bridge(),
      token,
      fetchImplementation,
    });
    for (let n = 0; n < 3; n++)
      await expect(
        repo.getChat({ ...input, tenantKey: 'test', sessionId: 'denied', limit: 50 }),
      ).rejects.toMatchObject({
        code: status === 404 ? 'COMMUNITY_EXPERIENCE_NOT_FOUND' : 'COMMUNITY_EXPERIENCE_FORBIDDEN',
      });
    allowed = true;
    expect(
      await repo.getChat({
        ...input,
        viewerUserId: 'other-user',
        tenantKey: 'test',
        sessionId: 'other-session',
        limit: 50,
      }),
    ).toMatchObject({ items: [] });
    expect(fetchImplementation).toHaveBeenCalledTimes(8);
    for (let n = 0; n < 3; n++) {
      token.mockRejectedValueOnce(new Error('revoked'));
      await expect(
        repo.getChat({ ...input, tenantKey: 'test', sessionId: 'denied', limit: 50 }),
      ).rejects.toMatchObject({ code: 'COMMUNITY_EXPERIENCE_FORBIDDEN' });
    }
    expect(
      await repo.getChat({ ...input, tenantKey: 'test', sessionId: 'valid', limit: 50 }),
    ).toMatchObject({ items: [] });
  },
);

it('station history binds public cursors and refuses an older owner instead of falling back', async () => {
  const seen: URL[] = [];
  let oldOwner = false;
  const fetchImplementation = vi.fn<typeof fetch>((url) => {
    const request = fetchUrl(url);
    seen.push(request);
    if (request.searchParams.has('view'))
      return Promise.resolve(
        Response.json({
          communities: [{ ...summary.communities[0], communityType: 'STATION' }],
        }),
      );
    if (oldOwner) return Promise.resolve(Response.json({ messages: [], nextBeforeTs: 0 }));
    expect([...request.searchParams.keys()].sort()).toEqual(
      request.searchParams.has('beforeId')
        ? ['beforeId', 'beforeTs', 'historyVersion', 'limit']
        : ['historyVersion', 'limit'],
    );
    const createdTs = Date.parse('2026-11-01T00:00:00.000Z');
    const publicId = request.searchParams.has('beforeId')
      ? '22222222-2222-5222-8222-222222222221'
      : '22222222-2222-8222-8222-222222222222';
    return Promise.resolve(
      Response.json({
        historyVersion: 2,
        messages: [
          {
            publicId,
            text: 'same',
            createdTs,
            createdAt: new Date(createdTs).toISOString(),
            authorName: 'Player',
          },
        ],
        nextBefore: { createdTs, publicId },
        hasMore: true,
      }),
    );
  });
  const repo = new LegacyCommunityExperienceRepository({
    baseUrl: 'https://legacy.test',
    timeoutMs: 1000,
    maxAttempts: 1,
    circuitFailureThreshold: 3,
    circuitResetMs: 1000,
    bridge: bridge(),
    fetchImplementation,
    token: () => Promise.resolve('synthetic-user-token'),
  });
  const actor = { ...input, sessionId: 'session', tenantKey: 'test', limit: 1 };
  const first = await repo.getChat(actor);
  const second = await repo.getChat({ ...actor, cursor: first.nextCursor! });
  expect(first.items[0]?.body).toBe(second.items[0]?.body);
  expect(first.items[0]?.id).not.toBe(second.items[0]?.id);
  expect(
    seen.filter((url) => url.pathname.endsWith('/messages'))[1]?.searchParams.get('beforeId'),
  ).toBe(first.items[0]?.id);
  const before = seen.filter((url) => url.pathname.endsWith('/messages')).length;
  await expect(
    repo.getChat({ ...actor, tenantId: 'foreign', cursor: first.nextCursor! }),
  ).rejects.toMatchObject({ code: 'COMMUNITY_EXPERIENCE_PROVIDER_INVALID' });
  expect(seen.filter((url) => url.pathname.endsWith('/messages'))).toHaveLength(before);
  oldOwner = true;
  await expect(repo.getChat(actor)).rejects.toMatchObject({
    code: 'COMMUNITY_EXPERIENCE_PROVIDER_INVALID',
  });
  expect(seen.filter((url) => url.pathname.endsWith('/messages'))).toHaveLength(before + 1);
});
