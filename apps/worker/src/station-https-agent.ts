import { lookup } from 'node:dns';
import { Agent } from 'node:https';
import { connect as connectTls, type ConnectionOptions, type TLSSocket } from 'node:tls';
import type { LookupFunction } from 'node:net';
import ipaddr from 'ipaddr.js';

export function isPublicWebPushAddress(address: string): boolean {
  if (!ipaddr.isValid(address)) return false;
  const parsed = ipaddr.parse(address);
  if (parsed instanceof ipaddr.IPv6 && parsed.isIPv4MappedAddress()) {
    return parsed.toIPv4Address().range() === 'unicast';
  }
  return parsed.range() === 'unicast';
}

export function areAllWebPushAddressesPublic(addresses: readonly string[]): boolean {
  return addresses.length > 0 && addresses.every(isPublicWebPushAddress);
}

function egressBlockedError(): NodeJS.ErrnoException {
  const error = new Error('Web Push endpoint resolved outside the public network');
  return Object.assign(error, { code: 'WEB_PUSH_EGRESS_BLOCKED' });
}

export function createPublicWebPushLookup(): LookupFunction {
  return (hostname, options, callback) => {
    lookup(
      hostname,
      {
        all: true,
        verbatim: true,
        ...(options.family === 4 || options.family === 6 ? { family: options.family } : {}),
        ...(options.hints === undefined ? {} : { hints: options.hints }),
      },
      (error, addresses) => {
        if (error) {
          callback(error, []);
          return;
        }
        if (!areAllWebPushAddressesPublic(addresses.map(({ address }) => address))) {
          callback(egressBlockedError(), []);
          return;
        }
        if (options.all) {
          callback(null, addresses);
          return;
        }
        const selected = addresses[0];
        if (!selected) {
          callback(egressBlockedError(), []);
          return;
        }
        callback(null, selected.address, selected.family);
      },
    );
  };
}

const stationNoSubmissionErrors = new WeakSet<Error>();
/** Only hands a fresh TLS socket to the waiting HTTP request while station authority is fresh. */
export function createStationHttpsAgent(
  canSubmit: () => boolean,
  connectImplementation: typeof connectTls = connectTls,
): Agent {
  const agent = new Agent({ keepAlive: false, maxSockets: 1, lookup: createPublicWebPushLookup() });
  agent.createConnection = ((
    options: ConnectionOptions,
    callback: (error: Error | null, socket?: TLSSocket) => void,
  ) => {
    const socket = connectImplementation({ ...options, lookup: createPublicWebPushLookup() });
    let done = false;
    // HTTP request timeout begins only after socket assignment; bound TLS/DNS preparation too.
    const timer = setTimeout(() => {
      const error = new Error('STATION_NOT_SUBMITTED');
      stationNoSubmissionErrors.add(error);
      finish(error);
    }, 5000);
    const finish = (error: Error | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.removeListener('error', failed);
      if (error) {
        socket.destroy();
        callback(error);
      } else callback(null, socket);
    };
    const failed = (error: Error) => finish(error);
    socket.once('error', failed);
    socket.once('secureConnect', () => {
      let allowed = false;
      try {
        allowed = canSubmit();
      } catch {
        /* Deny before handoff. */
      }
      if (allowed) finish(null);
      else {
        const error = new Error('STATION_NOT_SUBMITTED');
        stationNoSubmissionErrors.add(error);
        finish(error);
      }
    });
    return undefined;
  }) as typeof agent.createConnection;
  return agent;
}

export function isStationNotSubmitted(error: unknown): boolean {
  return error instanceof Error && stationNoSubmissionErrors.has(error);
}
