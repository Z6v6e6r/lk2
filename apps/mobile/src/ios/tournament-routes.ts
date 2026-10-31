import { nativeTournamentRequest } from '../native-tournament-request.js';
import type { IOSConfiguration } from './session.js';

/** Same concrete public contract as Android; Swift independently constructs every destination. */
export function tournamentRequest(
  value: string,
  method: string,
  body: unknown,
  headers: Record<string, string>,
  config: IOSConfiguration,
) {
  const kind = nativeTournamentRequest(value, method, body, headers, config);
  if (!kind) return null;
  const url = new URL(value);
  const root = `/${kind === 'PUBLIC' ? 'public' : 'user'}/api/v1/${config.tenantKey}/tournaments`;
  const parts = url.pathname.slice(root.length).split('/').filter(Boolean);
  if (kind === 'PUBLIC')
    return {
      resource: parts.length ? 'summary' : 'list',
      ...(parts[0] ? { resourceId: parts[0] } : {}),
      query: Object.fromEntries(url.searchParams),
    };
  const resource =
    parts[1] === 'participants'
      ? 'participants'
      : parts[1] === 'registration-operation'
        ? 'status'
        : parts[1] === 'registrations'
          ? 'command'
          : 'retry';
  const operationId = resource === 'retry' ? parts[2] : url.searchParams.get('operationId');
  return {
    resource,
    resourceId: parts[0]!,
    ...(operationId ? { operationId } : {}),
    query: {},
  };
}
