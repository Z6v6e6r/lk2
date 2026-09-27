// Imported only by Playwright's intercepted main module. Never a production entry or fallback.
import { createRoot } from 'react-dom/client';
import { IOSAuthApp } from '../IOSAuthApp.js';
import { fixtureReply, nativeResult, syntheticSession } from './cabinet-fixtures.js';
import type { IOSSessionPlugin } from '../session.js';

let authenticated = !window.location.search.includes('signedout=1');
let unavailableResource: string | undefined;
export const operations: { readonly operation: string; readonly resource?: string }[] = [];
export function failResource(resource?: string): void {
  unavailableResource = resource;
}

const request: IOSSessionPlugin['request'] = async (input) => {
  operations.push({
    operation: input.operation,
    ...(input.resource ? { resource: input.resource } : {}),
  });
  if (input.operation === 'refresh' && !authenticated)
    return await Promise.resolve(nativeResult({ code: 'AUTH_SESSION_REVOKED' }, 401));
  if (input.operation === 'verify') authenticated = true;
  if (input.operation === 'logout') authenticated = false;
  if (input.operation === 'read' && input.resource === unavailableResource)
    return await Promise.resolve(nativeResult({ code: 'UNAVAILABLE' }, 503));
  return await Promise.resolve(fixtureReply(input));
};
const session = syntheticSession(request);
await session.restore();
createRoot(document.getElementById('root')!).render(<IOSAuthApp session={session} />);
