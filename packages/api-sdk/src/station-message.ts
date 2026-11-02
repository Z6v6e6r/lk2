import type { components } from '@phub/api-contracts';
type Receipt = components['schemas']['StationMessageReceipt'];
const unknownCodes: readonly string[] = [
  'MESSAGE_CONTRACT_REQUIRED',
  'COMMUNITY_AUTH_REQUIRED',
  'MESSAGE_REQUEST_INVALID',
  'MESSAGE_STATUS_WRITE_FORBIDDEN',
  'MESSAGE_STORE_UNAVAILABLE',
  'COMMUNITY_MESSAGE_ACCESS_UNAVAILABLE',
  'MESSAGE_RECEIPT_UNPROVEN',
  'MESSAGE_STATUS_STATE_INVALID',
  'MESSAGE_CUSTODY_UNPROVEN',
  'MESSAGE_REQUEST_CONFLICT',
  'MESSAGE_COMMIT_INVALID',
  'MESSAGE_REQUEST_TERMINAL',
  'MESSAGE_COMMIT_UNPROVEN',
  'MESSAGE_ACCEPTANCE_UNPROVEN',
  'MESSAGE_COMMUNITY_CHANGED',
  'COMMUNITY_MESSAGE_ACCESS_DENIED',
  'COMMUNITY_MESSAGE_ACCESS_CHANGED',
  'MESSAGE_OUTBOX_FULL',
  'MESSAGE_ACCEPTANCE_CONFLICT',
  'MESSAGE_EVENT_UNPROVEN',
  'MESSAGE_STATE_INVALID',
  'MESSAGE_STEP_LIMIT',
];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const keys = (value: Record<string, unknown>, names: string[]) =>
  Object.keys(value).length === names.length && names.every((key) => Object.hasOwn(value, key));
export function parseStationMessageReceipt(
  value: unknown,
  requestId: string,
  text?: string,
): Receipt {
  const fail = (): never => {
    throw new Error('STATION_MESSAGE_RECEIPT_UNKNOWN');
  };
  if (
    !record(value) ||
    value.contractVersion !== 1 ||
    value.contract !== 'station-message' ||
    value.requestId !== requestId ||
    !uuid.test(requestId)
  )
    return fail();
  if (
    value.outcome === 'UNKNOWN' &&
    keys(value, ['contractVersion', 'contract', 'requestId', 'outcome', 'code']) &&
    typeof value.code === 'string' &&
    unknownCodes.includes(value.code)
  )
    return value as Receipt;
  const m = value.message;
  if (
    value.outcome !== 'CONFIRMED' ||
    !keys(value, ['contractVersion', 'contract', 'requestId', 'outcome', 'message']) ||
    !record(m) ||
    !keys(m, ['id', 'body', 'sentAt', 'author', 'isViewer']) ||
    typeof m.id !== 'string' ||
    !uuid.test(m.id) ||
    typeof m.body !== 'string' ||
    !m.body.trim() ||
    m.body.length > 8000 ||
    (text !== undefined && m.body !== text.trim()) ||
    typeof m.sentAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(m.sentAt) ||
    !Number.isFinite(Date.parse(m.sentAt)) ||
    m.isViewer !== true ||
    !record(m.author) ||
    !keys(m.author, ['displayName']) ||
    typeof m.author.displayName !== 'string' ||
    !m.author.displayName.trim() ||
    m.author.displayName.length > 120
  )
    return fail();
  return value as Receipt;
}
