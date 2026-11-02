/* eslint-disable @typescript-eslint/require-await -- Synthetic transport only. */
import { readFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import type { TournamentNotificationIdentity } from '@phub/database/tournament-notifications';
import {
  TournamentNotificationOwnerClient,
  type TournamentFeedRecipient,
  type TournamentFeedPublicationInput,
} from './tournament-chat-notification-owner.js';

// The paired CUP emitter executes its actual service, then stores the original JSON
// strings verbatim. CI consumes the captured synthetic fixture; a local override can
// test fresh paired output. Neither mode fabricates CUP responses.
interface EmittedWire {
  source: string;
  scope: { tenantId: string; tenantKey: string; ownerTenantKey: string };
  identity: TournamentNotificationIdentity;
  input: TournamentFeedPublicationInput;
  candidate: TournamentFeedRecipient;
  wire: { publications: string; recipients: string; eligibility: string };
}
const wireFile =
  process.env.TOURNAMENT_NOTIFICATION_WIRE_FILE ??
  new URL('./fixtures/tournament-chat-notification-cup-wire.json', import.meta.url);
it('decodes unchanged JSON emitted by the actual paired CUP notification service', async () => {
  const emitted = JSON.parse(readFileSync(wireFile, 'utf8')) as EmittedWire;
  expect(emitted.source).toBe('Actual CUP notification service; synthetic memory only');
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const transport = vi.fn<typeof fetch>();
  const owner = new TournamentNotificationOwnerClient({
    baseUrl: 'https://cup.invalid',
    tenantId: emitted.scope.tenantId,
    tenantKey: emitted.scope.tenantKey,
    ownerTenantKey: emitted.scope.ownerTenantKey,
    issuer: 'synthetic-wire',
    kid: 'synthetic',
    privateKey,
    resolve: async () => emitted.identity,
    fetchImplementation: transport,
    now: () => (JSON.parse(emitted.wire.eligibility) as { observedAt: number }).observedAt,
  });
  transport.mockResolvedValueOnce(new Response(emitted.wire.publications));
  const page = await owner.publications(emitted.input);
  transport.mockResolvedValueOnce(new Response(emitted.wire.recipients));
  const recipients = await owner.recipients(page.facts[0]!);
  expect(recipients.candidates).toContainEqual(emitted.candidate);
  transport.mockResolvedValueOnce(new Response(emitted.wire.eligibility));
  await expect(owner.eligibility(page.facts[0]!, emitted.candidate)).resolves.toMatchObject({
    decision: 'ALLOW',
  });
  transport.mockResolvedValueOnce(new Response(emitted.wire.publications));
  await expect(
    owner.publications({ ...emitted.input, tournamentId: emitted.identity.userId }),
  ).rejects.toThrow();
  transport.mockResolvedValueOnce(new Response(emitted.wire.recipients));
  await expect(owner.recipients({ ...page.facts[0]!, factHash: 'f'.repeat(64) })).rejects.toThrow();
  transport.mockResolvedValueOnce(new Response(emitted.wire.eligibility));
  await expect(
    owner.eligibility(page.facts[0]!, {
      ...emitted.candidate,
      baselineSequence: 1,
      capturedReadThroughSequence: 1,
    }),
  ).rejects.toThrow();
  expect(JSON.stringify(emitted.wire)).not.toContain('Synthetic identical');
  expect(JSON.stringify(emitted.wire)).not.toContain('1202555');
});
