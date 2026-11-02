import {
  MonthlyPurchaseError,
  mpPath,
  mpUuid,
  mpId,
  mpIso,
  mpBody,
  parseMonthlyOwnerQuote,
  parseMonthlyOwnerReceipt,
  type MonthlyMode,
  type MonthlyOwnerQuote,
} from '@phub/domain/subscription-purchase';
import type { SubscriptionPurchaseConsent } from '@phub/api-contracts';
export interface MonthlyOwnerEnvelope {
  operationId: string;
  actorDelegation: string;
  correlationId: string;
  actorToken: { token: string; expiresAt: string };
}
export class MonthlyPurchaseOwnerClient {
  private failures = 0;
  private openUntil = 0;
  constructor(
    private readonly options: {
      baseUrl: string;
      environment: 'development' | 'production';
      timeoutMs: number;
      fetchImplementation?: typeof fetch;
      onMetric?: (m: {
        operation: MonthlyMode;
        outcome: 'success' | 'failure';
        durationMs: number;
      }) => void;
    },
  ) {
    const u = new URL(options.baseUrl);
    if (
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      u.pathname !== '/' ||
      !Number.isInteger(options.timeoutMs) ||
      options.timeoutMs < 100 ||
      options.timeoutMs > 10000 ||
      (options.environment === 'production'
        ? u.href !== 'https://padlhub.su/'
        : u.protocol !== 'https:' &&
          !(u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)))
    )
      throw new MonthlyPurchaseError();
  }
  async quote(e: MonthlyOwnerEnvelope) {
    return parseMonthlyOwnerQuote(await this.send('quote', e), e.operationId);
  }
  async purchase(
    e: MonthlyOwnerEnvelope,
    consent: SubscriptionPurchaseConsent,
    quote: MonthlyOwnerQuote,
  ) {
    return parseMonthlyOwnerReceipt(await this.send('purchase', e, consent, quote), quote);
  }
  async read(e: MonthlyOwnerEnvelope, quote: MonthlyOwnerQuote, reconcile = false) {
    return parseMonthlyOwnerReceipt(
      await this.send(reconcile ? 'reconcile' : 'read', e, undefined, quote),
      quote,
    );
  }
  private async send(
    mode: MonthlyMode,
    e: MonthlyOwnerEnvelope,
    consent?: SubscriptionPurchaseConsent,
    quote?: MonthlyOwnerQuote,
  ): Promise<unknown> {
    if (
      !mpUuid(e.operationId) ||
      !mpId(e.correlationId) ||
      /[\r\n]/.test(e.actorDelegation) ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$(?![\s\S])/.test(e.actorDelegation) ||
      e.actorDelegation.length > 8192 ||
      !e.actorToken ||
      /[\r\n]/.test(e.actorToken.token) ||
      !/^[!-~]{16,4096}$(?![\s\S])/.test(e.actorToken.token) ||
      !mpIso(e.actorToken.expiresAt) ||
      Date.parse(e.actorToken.expiresAt) <= Date.now()
    )
      throw new MonthlyPurchaseError();
    if (Date.now() < this.openUntil) throw new MonthlyPurchaseError();
    const body = mpBody(mode, consent),
      controller = new AbortController(),
      start = performance.now();
    let outcome: 'success' | 'failure' = 'failure',
      timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new MonthlyPurchaseError('SUBSCRIPTION_PURCHASE_UNAVAILABLE', 504));
      }, this.options.timeoutMs);
    });
    const url = new URL(mpPath(mode), this.options.baseUrl).href;
    const work = async () => {
      // Exactly one attempt. A timeout is an ambiguous command, never a retry signal.
      const response = await (this.options.fetchImplementation ?? fetch)(url, {
        method: 'POST',
        redirect: 'error',
        cache: 'no-store',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'X-Subscription-Actor-Delegation': e.actorDelegation,
          'X-Correlation-ID': e.correlationId,
          'X-Subscription-Actor-Token': e.actorToken.token,
        },
        body: JSON.stringify(body),
      });
      if (
        (response.url && response.url !== url) ||
        !/^application\/json(?:;|$)/i.test(response.headers.get('content-type') ?? '')
      ) {
        await response.body?.cancel();
        throw new MonthlyPurchaseError();
      }
      const reader = response.body?.getReader();
      if (!reader) throw new MonthlyPurchaseError();
      let bytes = 0,
        text = '';
      const decoder = new TextDecoder('utf-8', { fatal: true });
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 32768) {
            await reader.cancel();
            throw new MonthlyPurchaseError();
          }
          text += decoder.decode(chunk.value, { stream: true });
        }
        text += decoder.decode();
      } finally {
        reader.releaseLock();
      }
      if (response.status !== 200) throw new MonthlyPurchaseError();
      const value: unknown = JSON.parse(text);
      if (mode === 'quote') return parseMonthlyOwnerQuote(value, e.operationId);
      if (!quote) throw new MonthlyPurchaseError();
      return parseMonthlyOwnerReceipt(value, quote);
    };
    try {
      const value = await Promise.race([work(), deadline]);
      this.failures = 0;
      this.openUntil = 0;
      outcome = 'success';
      return value;
    } catch {
      this.failures++;
      if (this.failures >= 3) this.openUntil = Date.now() + 30000;
      throw new MonthlyPurchaseError();
    } finally {
      clearTimeout(timer);
      try {
        this.options.onMetric?.({
          operation: mode,
          outcome,
          durationMs: Math.max(0, performance.now() - start),
        });
      } catch {
        /* Telemetry cannot change custody. */
      }
    }
  }
}
