import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

/** Shared by the two Android media relays; no raw principal or token is retained. */
export function binaryMediaPrincipalKey(request: FastifyRequest): string {
  const scoped = request as FastifyRequest & {
    tenantId?: string;
    padlHubClaims?: { sub?: string };
  };
  return createHash('sha256')
    .update(`${scoped.tenantId ?? ''}:${scoped.padlHubClaims?.sub ?? ''}`)
    .digest('hex');
}

export const androidBinaryMediaRateLimit = {
  max: 60,
  timeWindow: 60_000,
  hook: 'onRequest' as const,
  groupId: 'android-binary-media-read',
  allowList: (request: FastifyRequest) => request.headers['x-app-platform'] !== 'android',
  keyGenerator: binaryMediaPrincipalKey,
  errorResponseBuilder: () => ({ statusCode: 429 }),
};

export function createBinaryMediaReadBudget(maxPerPrincipal = 4, maxTotal = 8) {
  const principals = new Map<string, number>();
  let total = 0;
  return {
    acquire(key: string): (() => void) | undefined {
      const current = principals.get(key) ?? 0;
      if (current >= maxPerPrincipal || total >= maxTotal) return undefined;
      principals.set(key, current + 1);
      total += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        total -= 1;
        const remaining = (principals.get(key) ?? 1) - 1;
        if (remaining) principals.set(key, remaining);
        else principals.delete(key);
      };
    },
  };
}
export const binaryMediaReadBudget = createBinaryMediaReadBudget();

/** Retain buffered bytes in the budget until the response is handed off or its socket closes. */
export function releaseBinaryReadWithResponse(reply: FastifyReply, release: () => void): void {
  if (reply.raw.destroyed || reply.raw.writableFinished) {
    release();
    return;
  }
  reply.raw.once('finish', release);
  reply.raw.once('close', release);
}
