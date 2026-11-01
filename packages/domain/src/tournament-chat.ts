/** Concrete CUP tournament-chat.v1 wire. No membership truth is inferred here. */
export const TOURNAMENT_CHAT_VERSION = 'tournament-chat.v1' as const;
export const tournamentChatUuid = (x: unknown): x is string =>
  typeof x === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(x);
const record = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === 'object' && !Array.isArray(x);
const keys = (x: Record<string, unknown>, k: string) => Object.keys(x).sort().join(',') === k;
const count = (x: unknown): x is number =>
  Number.isSafeInteger(x) && Number(x) >= 0 && Number(x) < Number.MAX_SAFE_INTEGER;
const hash = (x: unknown): x is string => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
export class TournamentChatError extends Error {
  constructor(
    readonly code:
      | 'TOURNAMENT_CHAT_INPUT_INVALID'
      | 'TOURNAMENT_CHAT_UNAVAILABLE'
      | 'TOURNAMENT_CHAT_FORBIDDEN'
      | 'TOURNAMENT_CHAT_CONFLICT' = 'TOURNAMENT_CHAT_UNAVAILABLE',
    readonly status: 400 | 403 | 409 | 503 = 503,
  ) {
    super(code);
  }
}
const fail = (): never => {
  throw new TournamentChatError();
};
export interface TournamentChatRequest {
  readonly requestId: string;
  readonly text: string;
}
export function tournamentChatText(x: unknown): x is string {
  return (
    typeof x === 'string' &&
    x.trim().length > 0 &&
    x.length <= 8000 &&
    !x.includes('\0') &&
    new TextEncoder().encode(x).length <= 32000 &&
    new TextDecoder('utf-8', { ignoreBOM: true }).decode(new TextEncoder().encode(x)) === x
  );
}
export function parseTournamentChatRequest(x: unknown): TournamentChatRequest {
  if (
    !record(x) ||
    !keys(x, 'requestId,text') ||
    !tournamentChatUuid(x.requestId) ||
    !tournamentChatText(x.text)
  )
    throw new TournamentChatError('TOURNAMENT_CHAT_INPUT_INVALID', 400);
  return { requestId: x.requestId, text: x.text };
}
export const tournamentChatSendBody = (tournamentId: string, x: TournamentChatRequest) =>
  JSON.stringify({ contractVersion: 1, tournamentId, requestId: x.requestId, text: x.text });
export async function tournamentChatRequestHash(
  tournamentId: string,
  x: TournamentChatRequest,
  cryptoApi: Pick<Crypto, 'subtle'> = crypto,
): Promise<string> {
  if (!tournamentChatUuid(tournamentId)) return fail();
  const bytes = new TextEncoder().encode(
    'tournament-chat-request:v1\0' +
      tournamentChatSendBody(tournamentId, parseTournamentChatRequest(x)),
  );
  return Array.from(new Uint8Array(await cryptoApi.subtle.digest('SHA-256', bytes)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}
export type TournamentChatReceipt = {
  readonly contractVersion: typeof TOURNAMENT_CHAT_VERSION;
  readonly tournamentId: string;
  readonly requestId: string;
} & (
  | { readonly status: 'UNKNOWN' }
  | {
      readonly status: 'CONFIRMED';
      readonly requestHash: string;
      readonly streamId: string;
      readonly messageId: string;
      readonly sequence: number;
    }
);
export function parseTournamentChatReceipt(
  x: unknown,
  tournamentId: string,
  requestId: string,
  expectedHash?: string,
): TournamentChatReceipt {
  if (
    !record(x) ||
    x.contractVersion !== TOURNAMENT_CHAT_VERSION ||
    x.tournamentId !== tournamentId ||
    x.requestId !== requestId ||
    !tournamentChatUuid(tournamentId) ||
    !tournamentChatUuid(requestId)
  )
    return fail();
  if (x.status === 'UNKNOWN' && keys(x, 'contractVersion,requestId,status,tournamentId'))
    return x as unknown as TournamentChatReceipt;
  if (
    x.status !== 'CONFIRMED' ||
    !keys(
      x,
      'contractVersion,messageId,requestHash,requestId,sequence,status,streamId,tournamentId',
    ) ||
    !hash(x.requestHash) ||
    (expectedHash !== undefined && x.requestHash !== expectedHash) ||
    !tournamentChatUuid(x.streamId) ||
    !tournamentChatUuid(x.messageId) ||
    !count(x.sequence) ||
    x.sequence < 1
  )
    return fail();
  return x as unknown as TournamentChatReceipt;
}
export interface TournamentChatCursor {
  readonly v: 1;
  readonly tenantId: string;
  readonly tournamentId: string;
  readonly actorUserId: string;
  readonly streamId: string;
  readonly witnessHash: string;
  readonly through: number;
  readonly before: number;
}
export function parseTournamentChatCursor(raw: string): TournamentChatCursor {
  try {
    if (!/^[A-Za-z0-9_-]{1,1800}$/.test(raw)) return fail();
    const b64 = raw.replace(/-/g, '+').replace(/_/g, '/');
    if (btoa(atob(b64)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') !== raw)
      return fail();
    const json = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)),
    );
    const x: unknown = JSON.parse(json);
    if (
      !record(x) ||
      !keys(x, 'actorUserId,before,streamId,tenantId,through,tournamentId,v,witnessHash') ||
      x.v !== 1 ||
      ![x.tenantId, x.tournamentId, x.actorUserId, x.streamId].every(tournamentChatUuid) ||
      !hash(x.witnessHash) ||
      !count(x.through) ||
      !Number.isSafeInteger(x.before) ||
      Number(x.before) < 1 ||
      Number(x.before) > x.through + 1
    )
      return fail();
    return x as unknown as TournamentChatCursor;
  } catch {
    return fail();
  }
}
export interface TournamentChatMessage {
  readonly messageId: string;
  readonly authorUserId: string;
  readonly text: string;
  readonly sequence: number;
  readonly acceptedAt: string;
}
export interface TournamentChatPage {
  readonly contractVersion: typeof TOURNAMENT_CHAT_VERSION;
  readonly tournamentId: string;
  readonly streamId: string | null;
  readonly throughSequence: number;
  readonly messages: readonly TournamentChatMessage[];
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
}
export function parseTournamentChatPage(
  x: unknown,
  tournamentId: string,
  limit: number,
  cursor?: string,
): TournamentChatPage {
  if (
    !record(x) ||
    !keys(x, 'contractVersion,hasMore,messages,nextCursor,streamId,throughSequence,tournamentId') ||
    x.contractVersion !== TOURNAMENT_CHAT_VERSION ||
    x.tournamentId !== tournamentId ||
    !tournamentChatUuid(tournamentId) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 50 ||
    !count(x.throughSequence) ||
    !Array.isArray(x.messages) ||
    x.messages.length > limit ||
    typeof x.hasMore !== 'boolean'
  )
    return fail();
  const c = cursor ? parseTournamentChatCursor(cursor) : undefined;
  if (x.streamId === null) {
    if (c || x.throughSequence !== 0 || x.messages.length || x.hasMore || x.nextCursor !== null)
      return fail();
  } else if (!tournamentChatUuid(x.streamId)) return fail();
  if (
    c &&
    (c.tournamentId !== tournamentId ||
      c.streamId !== x.streamId ||
      c.through !== x.throughSequence)
  )
    return fail();
  let sequence = Math.min(x.throughSequence + 1, c?.before ?? x.throughSequence + 1);
  const ids = new Set<string>();
  for (const m of x.messages as unknown[]) {
    if (
      !record(m) ||
      !keys(m, 'acceptedAt,authorUserId,messageId,sequence,text') ||
      !tournamentChatUuid(m.messageId) ||
      !tournamentChatUuid(m.authorUserId) ||
      !tournamentChatText(m.text) ||
      !count(m.sequence) ||
      m.sequence < 1 ||
      m.sequence !== sequence - 1 ||
      ids.has(m.messageId) ||
      typeof m.acceptedAt !== 'string' ||
      !Number.isFinite(Date.parse(m.acceptedAt)) ||
      new Date(m.acceptedAt).toISOString() !== m.acceptedAt
    )
      return fail();
    sequence = m.sequence;
    ids.add(m.messageId);
  }
  if (x.hasMore) {
    if (x.messages.length !== limit || sequence <= 1 || typeof x.nextCursor !== 'string')
      return fail();
    const next = parseTournamentChatCursor(x.nextCursor);
    if (
      next.tournamentId !== tournamentId ||
      next.streamId !== x.streamId ||
      next.through !== x.throughSequence ||
      next.before !== sequence ||
      (c &&
        (c.actorUserId !== next.actorUserId ||
          c.tenantId !== next.tenantId ||
          c.witnessHash !== next.witnessHash))
    )
      return fail();
  } else if (x.nextCursor !== null || sequence !== 1) return fail();
  return x as unknown as TournamentChatPage;
}
