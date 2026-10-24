import nodemailer, { type SendMailOptions } from 'nodemailer';
import { z } from 'zod';
import type { NotificationProviderDeliveryResult } from '@phub/notifications';
import { readNotificationCredentialFile } from './notification-provider-credentials.js';

const credentialSchema = z
  .object({ login: z.email().max(254), password: z.string().min(1).max(1024) })
  .strict();
export interface EmailDeliveryRequest {
  readonly deliveryId: string;
  readonly address: string;
  readonly title: string;
  readonly body: string;
}
interface MailResult {
  readonly accepted: readonly string[];
  readonly rejected: readonly string[];
  readonly messageId: string;
}
export interface SmtpTransport {
  sendMail(options: SendMailOptions): Promise<MailResult>;
  close(): void;
}
/** Fixed Yandex TLS transport; envelope sender is the authenticated corporate mailbox. */
export class YandexSmtpAdapter {
  private failures = 0;
  private openUntil = 0;
  private constructor(
    private readonly sender: string,
    private readonly makeTransport: () => SmtpTransport,
    private readonly timeoutMs: number,
    private readonly now: () => number,
    private readonly onOutcome?: (code: string) => void,
  ) {}
  static async create(input: {
    credentialFile: string;
    timeoutMs: number;
    now?: () => number;
    transportFactory?: (options: Parameters<typeof nodemailer.createTransport>[0]) => SmtpTransport;
    onOutcome?: (code: string) => void;
  }): Promise<YandexSmtpAdapter> {
    if (!Number.isFinite(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 30_000)
      throw new Error('SMTP_CONFIGURATION_INVALID');
    const credential = credentialSchema.parse(
      await readNotificationCredentialFile(input.credentialFile),
    );
    const options = {
      host: 'smtp.yandex.ru',
      port: 465,
      secure: true,
      requireTLS: true,
      tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
      auth: { user: credential.login, pass: credential.password },
      connectionTimeout: input.timeoutMs,
      greetingTimeout: input.timeoutMs,
      socketTimeout: input.timeoutMs,
      disableFileAccess: true,
      disableUrlAccess: true,
      logger: false,
      debug: false,
      pool: true,
      maxConnections: 1,
      maxMessages: 1,
    } as const;
    const makeTransport = (): SmtpTransport =>
      input.transportFactory?.(options) ?? nodemailer.createTransport(options);
    return new YandexSmtpAdapter(
      credential.login,
      makeTransport,
      input.timeoutMs,
      input.now ?? Date.now,
      input.onOutcome,
    );
  }
  private observe(result: NotificationProviderDeliveryResult): NotificationProviderDeliveryResult {
    if (
      result.outcome !== 'accepted' &&
      result.errorCode !== 'SMTP_CIRCUIT_OPEN' &&
      (result.outcome === 'retryable_failure' || result.errorCode === 'SMTP_OUTCOME_UNKNOWN')
    ) {
      if (++this.failures >= 3) this.openUntil = this.now() + 30_000;
    } else if (result.outcome !== 'retryable_failure') {
      this.failures = 0;
      this.openUntil = 0;
    }
    try {
      this.onOutcome?.(result.outcome === 'accepted' ? 'ACCEPTED' : result.errorCode);
    } catch {
      /* Telemetry cannot change send outcome. */
    }
    return result;
  }
  async send(request: EmailDeliveryRequest): Promise<NotificationProviderDeliveryResult> {
    if (this.openUntil > this.now())
      return this.observe({
        outcome: 'retryable_failure',
        errorCode: 'SMTP_CIRCUIT_OPEN',
        retryAfterMs: this.openUntil - this.now(),
      });
    const address = z.email().max(254).safeParse(request.address);
    if (
      !address.success ||
      /[\r\n]/.test(request.title) ||
      !request.title.trim() ||
      request.title.length > 300 ||
      request.body.length > 8000
    )
      return this.observe({
        outcome: 'terminal_failure',
        errorCode: 'SMTP_MESSAGE_INVALID',
        invalidate: false,
      });
    const transport = this.makeTransport();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const domain = this.sender.slice(this.sender.lastIndexOf('@') + 1);
      const sent = await Promise.race([
        transport.sendMail({
          from: { name: 'ПадлхАБ', address: this.sender },
          to: { address: address.data, name: '' },
          envelope: { from: this.sender, to: [address.data] },
          subject: request.title,
          text: request.body,
          messageId: `<${request.deliveryId}@${domain}>`,
          disableFileAccess: true,
          disableUrlAccess: true,
        }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            transport.close();
            reject(new Error('SMTP_TOTAL_TIMEOUT'));
          }, this.timeoutMs);
        }),
      ]);
      if (sent.accepted.includes(address.data) && sent.rejected.length === 0)
        return this.observe({ outcome: 'accepted', externalMessageId: sent.messageId });
      return this.observe({
        outcome: 'terminal_failure',
        errorCode: 'SMTP_RECIPIENT_REJECTED',
        invalidate: false,
      });
    } catch (error) {
      const failure = error as { responseCode?: unknown; code?: unknown };
      if (
        typeof failure.responseCode === 'number' &&
        failure.responseCode >= 500 &&
        failure.responseCode < 600 &&
        failure.code !== 'EAUTH'
      )
        return this.observe({
          outcome: 'terminal_failure',
          errorCode: 'SMTP_RECIPIENT_REJECTED',
          invalidate: false,
        });
      return this.observe(
        failure.code === 'EAUTH' ||
          (typeof failure.responseCode === 'number' &&
            failure.responseCode >= 400 &&
            failure.responseCode < 500)
          ? {
              outcome: 'retryable_failure',
              errorCode:
                failure.code === 'EAUTH' ? 'SMTP_AUTH_REJECTED' : 'SMTP_PROVIDER_RETRYABLE',
            }
          : { outcome: 'terminal_failure', errorCode: 'SMTP_OUTCOME_UNKNOWN', invalidate: false },
      );
    } finally {
      if (timer) clearTimeout(timer);
      transport.close();
    }
  }
}
