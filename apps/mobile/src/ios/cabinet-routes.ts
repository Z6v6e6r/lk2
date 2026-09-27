import { ApiClientError } from '@phub/api-sdk';
import type { IOSConfiguration } from './session.js';

export interface CabinetReadRequest {
  readonly operation: 'read';
  readonly resource: string;
  readonly resourceId?: string;
  readonly query: Record<string, string>;
}

const reads: Readonly<Record<string, readonly [string, readonly string[]]>> = {
  '/home': ['home', []],
  '/home/base': ['homeBase', []],
  '/profile': ['profile', []],
  '/profile/booking-preferences': ['preferences', []],
  '/profile/privacy': ['privacy', []],
  '/bookings/upcoming': ['bookings', []],
  '/bookings/history': ['history', ['kind', 'status', 'cursor', 'limit']],
  '/recommendations/bookings': ['recommendations', ['cursor', 'limit']],
  '/locations': ['locations', []],
  '/communities/mine': ['communities', ['cursor', 'limit']],
};
const gameFilters = [
  'stationId',
  'startsFrom',
  'startsTo',
  'kind',
  'levelFrom',
  'levelTo',
  'availability',
  'limit',
  'cursor',
] as const;

function reject(): never {
  throw new ApiClientError('Native read rejected', 400, 'NATIVE_REQUEST_REJECTED', 'native');
}

/** Recognize exact SDK GETs; native code independently constructs and validates the destination. */
export function cabinetReadRequest(
  value: string,
  config: IOSConfiguration,
): CabinetReadRequest | null {
  const rawPath = value.split('?')[0]!;
  // eslint-disable-next-line no-control-regex -- Reject control bytes and whitespace before URL normalization.
  if (/[%#\\]|\.\.|[\u0000-\u0020\u007f]/.test(rawPath) || value.includes('#')) reject();
  const user = `${config.apiBaseUrl}/user/api/v1/${config.tenantKey}`;
  const publicRoot = `${config.apiBaseUrl}/public/api/v1/${config.tenantKey}`;
  let resource: string;
  let resourceId: string | undefined;
  let allowed: readonly string[];
  if (rawPath === `${publicRoot}/games`) {
    resource = 'publicGames';
    allowed = gameFilters;
  } else if (rawPath.startsWith(`${user}/`)) {
    const path = rawPath.slice(user.length);
    const route = reads[path];
    const detail =
      /^\/(locations|games)\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.exec(
        path,
      );
    if (route) [resource, allowed] = route;
    else if (detail) {
      resource = detail[1] === 'locations' ? 'location' : 'game';
      resourceId = detail[2];
      allowed = [];
    } else return null;
  } else return null;
  const params = new URL(value).searchParams;
  const seen = new Set<string>();
  for (const [key, entry] of params) {
    if (
      !allowed.includes(key) ||
      seen.has(key) ||
      !entry ||
      entry.length > 2048 ||
      // eslint-disable-next-line no-control-regex -- Decoded control bytes are not valid native query values.
      /[\u0000-\u001f\u007f]/.test(entry)
    )
      reject();
    if (
      key === 'limit' &&
      (!/^[1-9][0-9]?$/.test(entry) || Number(entry) > (resource === 'recommendations' ? 20 : 50))
    )
      reject();
    if (key === 'cursor' && (entry.length < 16 || entry.length > 512)) reject();
    seen.add(key);
  }
  return {
    operation: 'read',
    resource,
    ...(resourceId ? { resourceId } : {}),
    query: Object.fromEntries(params),
  };
}
