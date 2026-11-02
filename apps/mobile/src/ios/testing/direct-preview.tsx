// Synthetic local browser interception only, never a production entry or fallback.
import { createRoot } from 'react-dom/client';
import { registerPlugin } from '@capacitor/core';
import { IOSAuthApp } from '../IOSAuthApp.js';
import { directFixture } from './direct-fixtures.js';
import { syntheticSession } from './cabinet-fixtures.js';

const fixture = directFixture();
export const loseResponse = fixture.loseResponse;
export const operations: { operation: string; resource?: string }[] = [];
registerPlugin('PadlHubIOSPush', {
  web: () => ({
    status: () =>
      Promise.resolve({
        configured: false,
        installationId: 'synthetic',
        pendingRevoke: false,
        state: 'unsupported',
      }),
    suspend: () => Promise.resolve({ installationId: 'synthetic', pendingRevoke: false }),
    takeOpened: () => Promise.resolve({}),
    addListener: () => Promise.resolve({ remove: () => Promise.resolve() }),
  }),
});
const session = syntheticSession(async (input) => {
  operations.push({
    operation: input.operation,
    ...(input.resource ? { resource: input.resource } : {}),
  });
  return await Promise.resolve(fixture.reply(input));
});
await session.restore();
createRoot(document.getElementById('root')!).render(<IOSAuthApp session={session} />);
