import { createHash } from 'node:crypto';
import type { WholeCourtCheckoutReceipt } from '@phub/database';
import { qcExact, qcId, qcIso, qcUuid } from '@phub/domain/quarter-create';

export type WholeCourtMode = 'reserve' | 'confirm';
export const wholeCourtOwnerPath = (mode: WholeCourtMode) =>
  '/lk/integrations/v1/whole-court-checkout/' + mode;
export const wholeCourtOwnerScope = (mode: WholeCourtMode) => 'game-create.whole-court.' + mode;
export const wholeCourtCheckoutOrigin = 'https://pay.vivacrm.ru';

export interface WholeCourtOwnerBody {
  readonly contractVersion: 1;
  readonly action: 'CREATE_GAME';
  readonly operationId: string;
  readonly draftId: string;
  readonly stationId: string;
  readonly roomId: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly amountMinor: number;
  readonly currency: 'RUB';
}

export function wholeCourtBodyJson(body: WholeCourtOwnerBody): string {
  if (
    !qcUuid(body.operationId) ||
    !qcUuid(body.draftId) ||
    !qcId(body.stationId) ||
    !qcId(body.roomId) ||
    !qcIso(body.startsAt) ||
    !qcIso(body.endsAt) ||
    !wholeCourtAmount(body.amountMinor)
  )
    throw new Error('WHOLE_COURT_OWNER_REQUEST_INVALID');
  return JSON.stringify({
    contractVersion: 1,
    action: 'CREATE_GAME',
    operationId: body.operationId,
    draftId: body.draftId,
    stationId: body.stationId,
    roomId: body.roomId,
    startsAt: body.startsAt,
    endsAt: body.endsAt,
    amountMinor: body.amountMinor,
    currency: 'RUB',
  });
}

export function wholeCourtOwnerHash(mode: WholeCourtMode, body: WholeCourtOwnerBody): string {
  return (
    'sha256:' +
    createHash('sha256')
      .update('whole-court:' + mode + ':v1\0' + wholeCourtBodyJson(body))
      .digest('hex')
  );
}

export function wholeCourtAmount(amount: unknown): amount is number {
  return (
    typeof amount === 'number' && Number.isSafeInteger(amount) && amount > 0 && amount <= 10_000_000
  );
}

export function parseWholeCourtReceipt(raw: unknown, amount: number): WholeCourtCheckoutReceipt {
  const r = qcExact(
    raw,
    'provider,transactionId,bookingId,exerciseId,amountMinor,currency,confirmedAt',
  );
  if (
    r.provider !== 'VIVA' ||
    !qcId(r.transactionId) ||
    !qcId(r.bookingId) ||
    !qcId(r.exerciseId) ||
    r.amountMinor !== amount ||
    r.currency !== 'RUB' ||
    !qcIso(r.confirmedAt) ||
    Date.parse(r.confirmedAt) > Date.now() + 5_000
  )
    throw new Error('WHOLE_COURT_OWNER_RECEIPT_INVALID');
  return {
    provider: 'VIVA',
    transactionId: r.transactionId,
    bookingId: r.bookingId,
    exerciseId: r.exerciseId,
    amountMinor: amount,
    currency: 'RUB',
    confirmedAt: r.confirmedAt,
  };
}

type WholeCourtOwnerOutcome =
  | { status: 'UNKNOWN' }
  | { status: 'AWAITING_PAYMENT'; url: string; expiresAt: string }
  | { status: 'CONFIRMED'; receipt: WholeCourtCheckoutReceipt };

export interface WholeCourtOwnerRequest {
  readonly mode: WholeCourtMode;
  readonly body: WholeCourtOwnerBody;
  readonly delegation: string;
  readonly token: string;
  readonly correlationId: string;
}

export function createWholeCourtOwner(options: {
  readonly baseUrl: string;
  readonly allowLoopback?: boolean;
  readonly timeoutMs: number;
  readonly fetchImplementation?: typeof fetch;
  readonly onMetric?: (mode: WholeCourtMode, outcome: string) => void;
}) {
  const base = new URL(options.baseUrl);
  const loopback =
    options.allowLoopback &&
    base.protocol === 'http:' &&
    ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
  if (
    (!loopback && base.href !== 'https://padlhub.su/') ||
    !Number.isInteger(options.timeoutMs) ||
    options.timeoutMs < 100 ||
    options.timeoutMs > 30_000 ||
    base.pathname !== '/' ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw new Error('WHOLE_COURT_OWNER_URL_INVALID');
  let failureCount = 0;
  let openUntil = 0;
  let probe = false;

  return async function request(input: WholeCourtOwnerRequest): Promise<WholeCourtOwnerOutcome> {
    if (Date.now() < openUntil || probe) {
      try {
        options.onMetric?.(input.mode, 'CIRCUIT_OPEN');
      } catch {
        /* optional telemetry */
      }
      return { status: 'UNKNOWN' };
    }
    const halfOpen = openUntil > 0;
    if (halfOpen) probe = true;
    const bad = (code: string): never => {
      throw new Error(code);
    };
    try {
      const requested = new URL(wholeCourtOwnerPath(input.mode), base).href;
      const response = await (options.fetchImplementation ?? fetch)(requested, {
        method: 'POST',
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(options.timeoutMs),
        headers: {
          'Content-Type': 'application/json',
          'X-Subscription-Actor-Delegation': input.delegation,
          'X-Subscription-Actor-Token': input.token,
          'X-Correlation-ID': input.correlationId,
        },
        body: wholeCourtBodyJson(input.body),
      });
      if (
        (response.url && response.url !== requested) ||
        ![200, 202].includes(response.status) ||
        !/^application\/json(?:\s*;|$)/i.test(response.headers.get('Content-Type') ?? '')
      ) {
        await response.body?.cancel();
        return bad('WHOLE_COURT_OWNER_RESPONSE_INVALID');
      }
      const reader = response.body?.getReader();
      if (!reader) return bad('WHOLE_COURT_OWNER_RESPONSE_INVALID');
      const decoder = new TextDecoder();
      let bytes = 0;
      let data = '';
      try {
        for (;;) {
          const piece = await reader.read();
          if (piece.done) break;
          bytes += piece.value.byteLength;
          if (bytes > 8192) {
            await reader.cancel();
            return bad('WHOLE_COURT_OWNER_RESPONSE_INVALID');
          }
          data += decoder.decode(piece.value, { stream: true });
        }
      } finally {
        reader.releaseLock();
      }
      const raw: unknown = JSON.parse(data + decoder.decode());
      const r = raw as Record<string, unknown> | null;
      if (!r || r.operationId !== input.body.operationId || r.draftId !== input.body.draftId)
        return bad('WHOLE_COURT_OWNER_BINDING_INVALID');

      let outcome: WholeCourtOwnerOutcome;
      if (r.status === 'UNKNOWN' && response.status === 202) {
        qcExact(r, 'status,operationId,draftId');
        outcome = { status: 'UNKNOWN' };
      } else if (r.status === 'CONFIRMED' && response.status === 200) {
        qcExact(r, 'status,operationId,draftId,receipt');
        outcome = {
          status: 'CONFIRMED',
          receipt: parseWholeCourtReceipt(r.receipt, input.body.amountMinor),
        };
      } else {
        qcExact(r, 'status,operationId,draftId,paymentUrl,expiresAt,amountMinor,currency');
        if (
          input.mode !== 'reserve' ||
          r.status !== 'AWAITING_PAYMENT' ||
          response.status !== 200 ||
          r.amountMinor !== input.body.amountMinor ||
          r.currency !== 'RUB' ||
          typeof r.paymentUrl !== 'string' ||
          r.paymentUrl.length > 2048 ||
          !/^https:\/\/[^\s\\]+$/u.test(r.paymentUrl) ||
          !qcIso(r.expiresAt) ||
          Date.parse(r.expiresAt) <= Date.now()
        )
          return bad('WHOLE_COURT_OWNER_CHECKOUT_INVALID');
        const url = new URL(r.paymentUrl);
        if (url.origin !== wholeCourtCheckoutOrigin || url.username || url.password || url.hash)
          return bad('WHOLE_COURT_OWNER_CHECKOUT_INVALID');
        outcome = { status: 'AWAITING_PAYMENT', url: r.paymentUrl, expiresAt: r.expiresAt };
      }
      failureCount = 0;
      openUntil = 0;
      try {
        options.onMetric?.(input.mode, outcome.status);
      } catch {
        /* non-authoritative telemetry */
      }
      return outcome;
    } catch {
      if (++failureCount >= 3) openUntil = Date.now() + 15_000;
      try {
        options.onMetric?.(input.mode, 'UNAVAILABLE');
      } catch {
        /* non-authoritative telemetry */
      }
      return { status: 'UNKNOWN' };
    } finally {
      if (halfOpen) probe = false;
    }
  };
}
