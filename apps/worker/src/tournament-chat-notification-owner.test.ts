/* eslint-disable @typescript-eslint/require-await -- Synthetic asynchronous boundary fixtures. */
import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  TournamentNotificationOwnerClient,
  TOURNAMENT_FEED_VERSION,
  tournamentNotificationOwnerFromEnvironment,
  type TournamentFeedEligibility,
  type TournamentFeedRecipientPage,
} from './tournament-chat-notification-owner.js';
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const now = 1800000000000;
const digest = (domain: string, value: unknown) =>
  createHash('sha256')
    .update(domain + '\0' + JSON.stringify(value))
    .digest('hex');
const binding = { tournamentId: id(1), streamId: id(2), incarnationHash: 'a'.repeat(64) };
const fact = {
  ...binding,
  sequence: 1,
  messageId: id(3),
  authorUserId: id(4),
  factHash: 'b'.repeat(64),
};
const identity = {
  userId: id(5),
  providerMappingId: id(6),
  providerClientId: 'synthetic',
  ownerTenantKey: 'cup-owner',
  observedAt: now,
};
const witness = {
  kind: 'PARTICIPANT' as const,
  generation: id(7),
  actorHash: digest('tournament-local-actor:v1', [
    identity.ownerTenantKey,
    identity.providerClientId,
  ]),
};
const recipient = {
  witness,
  witnessHash: digest('tournament-chat-witness:v1', witness),
  baselineSequence: 0,
  capturedReadThroughSequence: 0,
};
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
function fixture() {
  const transport = vi.fn<typeof fetch>(),
    resolve = vi.fn(async () => identity);
  const owner = new TournamentNotificationOwnerClient({
    baseUrl: 'https://cup.invalid',
    tenantId: id(8),
    tenantKey: 'canonical',
    ownerTenantKey: 'cup-owner',
    issuer: 'synthetic',
    kid: 'test',
    privateKey,
    resolve,
    fetchImplementation: transport,
    now: () => now,
  });
  return { owner, transport, resolve };
}
const publications = {
  contractVersion: TOURNAMENT_FEED_VERSION,
  ...binding,
  throughSequence: 1,
  facts: [fact],
  nextAfterSequence: null,
  hasMore: false,
};
const recipients: TournamentFeedRecipientPage = {
  contractVersion: TOURNAMENT_FEED_VERSION,
  fact,
  throughSequence: 1,
  snapshotHash: 'c'.repeat(64),
  candidates: [recipient],
  nextCursor: null,
  hasMore: false,
};
const eligible: TournamentFeedEligibility = {
  contractVersion: TOURNAMENT_FEED_VERSION,
  fact,
  userId: identity.userId,
  witnessHash: recipient.witnessHash,
  baselineSequence: 0,
  decision: 'ALLOW',
  code: 'ELIGIBLE',
  observedAt: now,
  validUntil: now + 5000,
};
const response = (value: unknown) => new Response(JSON.stringify(value));
const input = { ...binding, afterSequence: 0, throughSequence: null, limit: 50 };
describe('dedicated readonly tournament notification client', () => {
  it('signs exact operation/body/namespace/correlation with its own purpose and short expiry', async () => {
    const f = fixture();
    f.transport.mockResolvedValue(response(publications));
    await f.owner.publications(input);
    const [url, options] = f.transport.mock.calls[0]!;
    expect(url).toBe(
      'https://cup.invalid/api/internal/tournaments/chat-notifications/v1/publications',
    );
    const headers = options!.headers as Record<string, string>,
      parts = headers.authorization!.slice(7).split('.');
    expect(
      verify(
        'RSA-SHA256',
        Buffer.from(parts[0] + '.' + parts[1]),
        publicKey,
        Buffer.from(parts[2]!, 'base64url'),
      ),
    ).toBe(true);
    const h = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString()) as Record<string, unknown>,
      p = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString()) as Record<string, unknown>;
    expect(h.typ).toBe('phub-tournament-chat-notifications+jwt');
    expect(p).toMatchObject({
      aud: 'cup-tournament-chat-notifications-v1',
      sub: 'lk2-tournament-notification-bridge',
      scope: 'tournaments.chat.notifications.publications',
      method: 'POST',
      owner_tenant_key: 'cup-owner',
      correlation_id: headers['x-correlation-id'],
    });
    expect(Number(p.exp) - Number(p.iat)).toBe(30);
    expect(p.request_sha256).toBe(
      createHash('sha256')
        .update(options!.body as string)
        .digest('hex'),
    );
    expect(p).not.toHaveProperty('session_id');
  });
  it.each([
    { ...publications, facts: [] },
    { ...publications, facts: [{ ...fact, sequence: 2 }] },
    { ...publications, facts: [{ ...fact, tournamentId: id(20) }] },
    { ...publications, throughSequence: 2 },
    { ...publications, text: 'private' },
    { ...publications, nextAfterSequence: 1 },
  ])('rejects hole, corrupt binding, frontier or unrecognized metadata', async (raw) => {
    const f = fixture();
    f.transport.mockResolvedValue(response(raw));
    await expect(f.owner.publications(input)).rejects.toThrow();
  });
  it('accepts empty eligible pages only with advancing scanned cursor, and pins snapshot and frontier', async () => {
    const f = fixture(),
      key = 'd'.repeat(64),
      cursor = Buffer.from(
        JSON.stringify({
          version: 1,
          factHash: fact.factHash,
          snapshotHash: recipients.snapshotHash,
          throughSequence: 1,
          afterWitnessHash: key,
        }),
      ).toString('base64url');
    f.transport.mockResolvedValueOnce(
      response({ ...recipients, candidates: [], hasMore: true, nextCursor: cursor }),
    );
    expect((await f.owner.recipients(fact)).nextCursor).toBe(cursor);
    f.transport.mockResolvedValueOnce(
      response({ ...recipients, candidates: [], snapshotHash: 'e'.repeat(64) }),
    );
    await expect(f.owner.recipients(fact, 50, cursor)).rejects.toThrow();
    f.transport.mockResolvedValueOnce(
      response({ ...recipients, candidates: [], hasMore: true, nextCursor: cursor }),
    );
    await expect(f.owner.recipients(fact, 50, cursor)).rejects.toThrow();
  });
  it('requires fresh canonical mapping for organizer as well as participant; no identity failure reaches CUP', async () => {
    const f = fixture();
    f.resolve.mockResolvedValueOnce({ ...identity, observedAt: now - 5000 });
    await expect(f.owner.eligibility(fact, recipient)).rejects.toThrow();
    expect(f.transport).not.toHaveBeenCalled();
    f.resolve.mockResolvedValueOnce({ ...identity, providerClientId: 'different' });
    await expect(f.owner.eligibility(fact, recipient)).rejects.toThrow();
    expect(f.transport).not.toHaveBeenCalled();
    const w = { kind: 'ORGANIZER' as const, revision: 1, selectedUserId: identity.userId },
      r = { ...recipient, witness: w, witnessHash: digest('tournament-chat-witness:v1', w) };
    f.transport.mockResolvedValue(response({ ...eligible, witnessHash: r.witnessHash }));
    await expect(f.owner.eligibility(fact, r)).resolves.toMatchObject({ decision: 'ALLOW' });
    expect(f.resolve).toHaveBeenLastCalledWith(fact.tournamentId, w);
  });
  it('organizer DENY never drops a later eligible participant for the same canonical user', async () => {
    const f = fixture(),
      w = { kind: 'ORGANIZER' as const, revision: 1, selectedUserId: identity.userId },
      org = { ...recipient, witness: w, witnessHash: digest('tournament-chat-witness:v1', w) };
    // Use service methods to isolate the dispatch adapter from hash-sorted wire ordering.
    vi.spyOn(f.owner, 'recipients').mockResolvedValue({
      ...recipients,
      candidates: [org, recipient],
    });
    vi.spyOn(f.owner, 'eligibility')
      .mockResolvedValueOnce({
        ...eligible,
        decision: 'DENY',
        code: 'CURRENT_CONTEXT_CHANGED',
        witnessHash: org.witnessHash,
      })
      .mockResolvedValueOnce(eligible);
    const page = await f.owner.resolveRecipientPage(fact);
    expect(page.allowed).toHaveLength(1);
    expect(page.allowed[0]!.recipient).toEqual(recipient);
  });
  it('refuses stale owner observations, author ALLOW and oversized/unrecognized responses', async () => {
    for (const raw of [
      { ...eligible, validUntil: now },
      { ...eligible, validUntil: now + 5001 },
      { ...eligible, userId: fact.authorUserId },
      { ...eligible, phone: 'private' },
    ]) {
      const f = fixture();
      f.transport.mockResolvedValue(response(raw));
      await expect(f.owner.eligibility(fact, recipient)).rejects.toThrow();
    }
    const f = fixture();
    f.transport.mockResolvedValue(new Response(' '.repeat(256001)));
    await expect(f.owner.publications(input)).rejects.toThrow();
  });
  it('deduplicates canonical users only after an eligible ALLOW observation', async () => {
    const f = fixture();
    vi.spyOn(f.owner, 'recipients').mockResolvedValue({
      ...recipients,
      candidates: [recipient, recipient],
    });
    vi.spyOn(f.owner, 'eligibility').mockResolvedValue(eligible);
    expect((await f.owner.resolveRecipientPage(fact)).allowed).toHaveLength(1);
  });
  it('fails closed for conflicting ALLOW observations from different witnesses for one user', async () => {
    const f = fixture(),
      w = { kind: 'ORGANIZER' as const, revision: 1, selectedUserId: identity.userId },
      org = { ...recipient, witness: w, witnessHash: digest('tournament-chat-witness:v1', w) };
    vi.spyOn(f.owner, 'recipients').mockResolvedValue({
      ...recipients,
      candidates: [org, recipient],
    });
    vi.spyOn(f.owner, 'eligibility')
      .mockResolvedValueOnce({ ...eligible, witnessHash: org.witnessHash })
      .mockResolvedValueOnce(eligible);
    await expect(f.owner.resolveRecipientPage(fact)).rejects.toThrow();
  });
  it('opens bounded dependency circuit without retries and remains disabled by default', async () => {
    const f = fixture();
    f.transport.mockResolvedValue(new Response('', { status: 503 }));
    for (let i = 0; i < 4; i++) await expect(f.owner.publications(input)).rejects.toThrow();
    expect(f.transport).toHaveBeenCalledTimes(3);
    expect(tournamentNotificationOwnerFromEnvironment({}, f.resolve)).toBeNull();
    expect(
      tournamentNotificationOwnerFromEnvironment({ TOURNAMENT_CHAT_ENABLED: 'true' }, f.resolve),
    ).toBeNull();
  });
});
