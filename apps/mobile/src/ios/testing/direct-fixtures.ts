import type { PlayerProfileView } from '@phub/api-sdk';
import type { IOSSessionPlugin } from '../session.js';
import { auth, game, nativeResult } from './cabinet-fixtures.js';
import { chatFixture, directId, peer } from './chat-fixtures.js';

export const otherProfile: PlayerProfileView = {
  profile: { ...peer, avatarUrl: '/user/api/v1/local-padel/protected-photo' },
  reachable: true,
  access: {
    audience: 'OTHER',
    tier: 'INTERACTION',
    visibleSections: ['BASIC'],
    contact: { status: 'HIDDEN' },
    chat: { status: 'AVAILABLE', route: `/chats/new?recipientUserId=${peer.userId}&open=1` },
  },
};
/** Only synthetic native replies; no transport, credential or provider fallback. */
export function directFixture() {
  const chats = chatFixture();
  let created = false;
  let loseResponse = false;
  const conversation = {
    id: directId,
    kind: 'DIRECT' as const,
    participant: peer,
    unreadCount: 0,
    updatedAt: '2026-10-31T09:00:00Z',
    notificationPolicy: { level: 'ALL' as const, muted: false },
  };
  const reply = (input: Parameters<IOSSessionPlugin['request']>[0]) => {
    if (input.operation === 'refresh')
      return nativeResult({
        ...auth,
        context: { ...auth.context, permissions: ['profile.read', 'chat.direct.create'] },
      });
    if (input.resource === 'playerProfile') return nativeResult(otherProfile);
    if (input.resource === 'publicGames')
      return nativeResult({
        items: [
          { ...game, participants: [{ ...peer, role: 'PLAYER', avatarUrl: null, level: 'C' }] },
        ],
        nextCursor: null,
      });
    if (input.resource === 'conversations') {
      const page = JSON.parse(chats.reply(input).body) as { items: { id: string }[] };
      return nativeResult({ items: page.items.filter((item) => created || item.id !== directId) });
    }
    if (input.resource === 'createDirect') {
      created = true;
      if (loseResponse) return nativeResult({ code: 'SYNTHETIC_UNAVAILABLE' }, 503);
      return nativeResult({ outcome: 'ok', conversation, created: true, replayed: false });
    }
    if (input.resource === 'realtimeTicket')
      return nativeResult({ code: 'REALTIME_MESSAGING_DISABLED' }, 404);
    return chats.reply(input);
  };
  return {
    reply,
    loseResponse: (value: boolean) => {
      loseResponse = value;
    },
    conversation,
  };
}
