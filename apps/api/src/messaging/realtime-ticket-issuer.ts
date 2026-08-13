import { randomUUID } from 'node:crypto';

import {
  REALTIME_TICKET_SCOPE,
  REALTIME_TICKET_TTL_SECONDS,
  realtimeTicketRedisKey,
} from '@phub/auth';
import type { AppConfig } from '@phub/config';
import type Redis from 'ioredis';
import { SignJWT } from 'jose';

export interface RealtimeTicketResult {
  readonly ticketId: string;
  readonly ticket: string;
  readonly expiresAt: string;
}

export interface RealtimeTicketIssuer {
  issue(input: {
    readonly tenantId: string;
    readonly tenantKey: string;
    readonly userId: string;
    readonly sessionId: string;
  }): Promise<RealtimeTicketResult>;
  revoke(ticketId: string): Promise<void>;
}

export class RedisRealtimeTicketIssuer implements RealtimeTicketIssuer {
  public constructor(
    private readonly redis: Pick<Redis, 'set' | 'del'>,
    private readonly config: Pick<
      AppConfig,
      'JWT_ACCESS_SECRET' | 'JWT_ISSUER' | 'JWT_REALTIME_AUDIENCE'
    >,
  ) {}

  public async issue(input: {
    readonly tenantId: string;
    readonly tenantKey: string;
    readonly userId: string;
    readonly sessionId: string;
  }): Promise<RealtimeTicketResult> {
    const ticketId = randomUUID();
    const issuedAt = Math.floor(Date.now() / 1_000);
    const expiresAtSeconds = issuedAt + REALTIME_TICKET_TTL_SECONDS;
    const stored = await this.redis.set(
      realtimeTicketRedisKey(ticketId),
      input.sessionId,
      'EX',
      REALTIME_TICKET_TTL_SECONDS,
      'NX',
    );
    if (stored !== 'OK') throw new Error('REALTIME_TICKET_STORE_FAILED');

    const ticket = await new SignJWT({
      scope: REALTIME_TICKET_SCOPE,
      tenantId: input.tenantId,
      tenantKey: input.tenantKey,
      sid: input.sessionId,
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer(this.config.JWT_ISSUER)
      .setAudience(this.config.JWT_REALTIME_AUDIENCE)
      .setSubject(input.userId)
      .setJti(ticketId)
      .setIssuedAt(issuedAt)
      .setExpirationTime(expiresAtSeconds)
      .sign(new TextEncoder().encode(this.config.JWT_ACCESS_SECRET));

    return { ticketId, ticket, expiresAt: new Date(expiresAtSeconds * 1_000).toISOString() };
  }

  public async revoke(ticketId: string): Promise<void> {
    await this.redis.del(realtimeTicketRedisKey(ticketId));
  }
}
