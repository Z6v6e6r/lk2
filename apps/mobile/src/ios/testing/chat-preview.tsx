// Synthetic local browser interception only; never imported by the production entry.
import { createRoot } from 'react-dom/client';
import { registerPlugin } from '@capacitor/core';
import { IOSAuthApp } from '../IOSAuthApp.js';
import { chatFixture } from './chat-fixtures.js';
import { nativeResult, syntheticSession } from './cabinet-fixtures.js';

const fixture = chatFixture();
let historyUnavailable = false;
export function failHistory(unavailable: boolean): void {
  historyUnavailable = unavailable;
}
registerPlugin('PadlHubIOSPush', {
  web: () => ({
    status: () =>
      Promise.resolve({
        configured: false,
        installationId: 'synthetic-installation',
        pendingRevoke: false,
        state: 'unsupported',
      }),
    suspend: () =>
      Promise.resolve({ installationId: 'synthetic-installation', pendingRevoke: false }),
    takeOpened: () => Promise.resolve({}),
    addListener: () => Promise.resolve({ remove: () => Promise.resolve() }),
  }),
});
const session = syntheticSession(
  async (input) =>
    await Promise.resolve(
      input.resource === 'conversationMessages' && historyUnavailable
        ? nativeResult({ code: 'SYNTHETIC_UNAVAILABLE' }, 503)
        : input.resource === 'realtimeTicket'
          ? nativeResult({ code: 'REALTIME_MESSAGING_DISABLED' }, 404)
          : fixture.reply(input),
    ),
);
await session.restore();
createRoot(document.getElementById('root')!).render(<IOSAuthApp session={session} />);
