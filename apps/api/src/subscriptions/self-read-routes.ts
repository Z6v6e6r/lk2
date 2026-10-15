import { createHmac, timingSafeEqual } from 'node:crypto';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { sendApiError } from '../http-errors.js';

const uuid = z
  .string()
  .uuid()
  .regex(/^[0-9a-f-]+$/);
const timestamp = z.string().datetime({ offset: true });
const itemSchema = z
  .object({
    id: uuid,
    title: z.string().trim().min(1).max(200).nullable(),
    kind: z.enum(['INDIVIDUAL', 'GROUP', 'UNKNOWN']),
    status: z.enum(['SCHEDULED', 'ACTIVE', 'PAUSED', 'EXHAUSTED', 'UNKNOWN']),
    remaining: z
      .object({
        amount: z.number().finite().nonnegative().nullable(),
        unit: z.enum(['VISITS', 'MINUTES', 'DAYS', 'UNITS', 'UNKNOWN']),
      })
      .strict()
      .refine((value) => value.unit !== 'UNKNOWN' || value.amount === null),
    // Null means unknown; it never asserts unlimited validity.
    validUntil: timestamp.nullable(),
  })
  .strict();
const sourcePageSchema = z
  .object({
    tenantId: uuid,
    userId: uuid,
    sessionId: uuid,
    coverage: z.literal('COMPLETE'),
    snapshot: z.object({ id: uuid, asOf: timestamp, staleAt: timestamp }).strict(),
    offset: z.number().int().nonnegative(),
    total: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    items: z.array(itemSchema).max(50),
  })
  .strict();

/** Canonical CURRENT products only. The owner must pin all pages to one complete snapshot.
 * Provider identifiers, Home summaries and client-relayed payloads are not valid source pages.
 * Absent trusted source => unavailable; this contract does not activate provider transport.
 */
export interface SubscriptionSelfReadSource {
  readPage(input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly sessionId: string;
    readonly correlationId: string;
    readonly offset: number;
    readonly limit: number;
    readonly snapshotId?: string;
    /** Pages are strictly ordered by canonical item UUID, with no repeated IDs. */
    readonly afterId?: string;
  }): Promise<z.infer<typeof sourcePageSchema>>;
}

const cursorSchema = z
  .object({
    version: z.literal(1),
    tenantId: uuid,
    userId: uuid,
    sessionId: uuid,
    snapshotId: uuid,
    asOf: timestamp,
    staleAt: timestamp,
    afterId: uuid,
    total: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    offset: z.number().int().positive(),
    limit: z.number().int().min(1).max(50),
    expiresAt: z.number().int().positive(),
  })
  .strict();
type Cursor = z.infer<typeof cursorSchema>;
export class SubscriptionSelfReadError extends Error {
  public constructor(public readonly code: 'SNAPSHOT_CHANGED' | 'UNAVAILABLE') {
    super(code);
    this.name = 'SubscriptionSelfReadError';
  }
}
const querySchema = z
  .object({
    cursor: z.string().min(1).max(4096).optional(),
    limit: z
      .string()
      .regex(/^(?:[1-9]|[1-4][0-9]|50)$/)
      .optional(),
  })
  .strict();
const CURSOR_TTL_MS = 15 * 60 * 1000;

function signature(payload: string, secret: string): Buffer {
  return createHmac('sha256', secret)
    .update('phub-subscriptions-self-cursor:v1:')
    .update(payload)
    .digest();
}

function encodeCursor(cursor: Cursor, secret: string): string {
  const payload = Buffer.from(JSON.stringify(cursor)).toString('base64url');
  return `${payload}.${signature(payload, secret).toString('base64url')}`;
}

function decodeCursor(value: string, secret: string): Cursor | undefined {
  const parts = value.split('.');
  if (parts.length !== 2) return undefined;
  const [payload, mac] = parts;
  if (!payload || !mac || !/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]+$/.test(mac)) {
    return undefined;
  }
  const actual = Buffer.from(mac, 'base64url');
  if (actual.toString('base64url') !== mac) return undefined;
  const expected = signature(payload, secret);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return undefined;
  try {
    const result = cursorSchema.safeParse(
      JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')),
    );
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

export function registerSubscriptionSelfReadRoutes(
  app: FastifyInstance,
  options: {
    readonly source?: SubscriptionSelfReadSource;
    readonly cursorSecret: string;
    readonly authenticatedTenantHandlers: readonly ((
      request: FastifyRequest,
      reply: FastifyReply,
    ) => Promise<void> | void)[];
    readonly now?: () => number;
  },
): void {
  const now = options.now ?? Date.now;
  app.get(
    '/user/api/v1/:tenantKey/subscriptions',
    {
      preHandler: [...options.authenticatedTenantHandlers],
    },
    async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      reply.header('Pragma', 'no-cache');
      const tenantId = request.tenantId;
      const userId = request.padlHubClaims?.sub;
      const sessionId = request.padlHubClaims?.sid;
      if (!tenantId || !userId || !sessionId) {
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      }
      if (!request.padlHubClaims?.permissions.includes('profile.read')) {
        return sendApiError(
          request,
          reply,
          403,
          'SUBSCRIPTIONS_PERMISSION_REQUIRED',
          'Нет права на чтение личных данных.',
        );
      }
      const query = querySchema.safeParse(request.query);
      const invalid = () =>
        sendApiError(
          request,
          reply,
          400,
          'SUBSCRIPTIONS_REQUEST_INVALID',
          'Некорректный запрос абонементов.',
        );
      if (!query.success) return invalid();
      const cursor = query.data.cursor
        ? decodeCursor(query.data.cursor, options.cursorSecret)
        : undefined;
      if (
        query.data.cursor &&
        (!cursor ||
          cursor.tenantId !== tenantId ||
          cursor.userId !== userId ||
          cursor.sessionId !== sessionId ||
          cursor.expiresAt <= now())
      ) {
        return invalid();
      }
      const limit = query.data.limit ? Number(query.data.limit) : (cursor?.limit ?? 20);
      if (cursor && cursor.limit !== limit) return invalid();
      if (!options.source) {
        return sendApiError(
          request,
          reply,
          503,
          'SUBSCRIPTIONS_READ_UNAVAILABLE',
          'Полный список абонементов пока недоступен.',
        );
      }
      try {
        const offset = cursor?.offset ?? 0;
        const parsed = sourcePageSchema.safeParse(
          await options.source.readPage({
            tenantId,
            userId,
            sessionId,
            correlationId: request.id,
            offset,
            limit,
            ...(cursor ? { snapshotId: cursor.snapshotId, afterId: cursor.afterId } : {}),
          }),
        );
        if (!parsed.success) throw new Error('SUBSCRIPTIONS_SOURCE_INVALID');
        const page = parsed.data;
        if (
          page.tenantId !== tenantId ||
          page.userId !== userId ||
          page.sessionId !== sessionId ||
          page.offset !== offset ||
          offset > page.total ||
          page.items.length !== Math.min(limit, page.total - offset) ||
          page.items.some((item, index) => {
            const previous = index === 0 ? cursor?.afterId : page.items[index - 1]?.id;
            return previous !== undefined && item.id <= previous;
          }) ||
          Date.parse(page.snapshot.asOf) > now() ||
          Date.parse(page.snapshot.staleAt) < Date.parse(page.snapshot.asOf)
        ) {
          throw new Error('SUBSCRIPTIONS_SOURCE_INVALID');
        }
        if (
          cursor &&
          (page.snapshot.id !== cursor.snapshotId ||
            page.snapshot.asOf !== cursor.asOf ||
            page.snapshot.staleAt !== cursor.staleAt ||
            page.total !== cursor.total)
        ) {
          return sendApiError(
            request,
            reply,
            409,
            'SUBSCRIPTIONS_SNAPSHOT_CHANGED',
            'Список изменился. Обновите его с первой страницы.',
          );
        }
        const nextOffset = offset + page.items.length;
        const hasMore = nextOffset < page.total;
        return reply.send({
          scope: 'CURRENT',
          coverage: page.coverage,
          snapshot: page.snapshot,
          freshness: Date.parse(page.snapshot.staleAt) <= now() ? 'STALE' : 'FRESH',
          items: page.items,
          page: {
            offset,
            limit,
            total: page.total,
            hasMore,
            nextCursor: hasMore
              ? encodeCursor(
                  {
                    version: 1,
                    tenantId,
                    userId,
                    sessionId,
                    snapshotId: page.snapshot.id,
                    asOf: page.snapshot.asOf,
                    staleAt: page.snapshot.staleAt,
                    afterId: page.items[page.items.length - 1]!.id,
                    total: page.total,
                    offset: nextOffset,
                    limit,
                    expiresAt: cursor?.expiresAt ?? now() + CURSOR_TTL_MS,
                  },
                  options.cursorSecret,
                )
              : null,
          },
        });
      } catch (error) {
        if (error instanceof SubscriptionSelfReadError && error.code === 'SNAPSHOT_CHANGED') {
          return sendApiError(
            request,
            reply,
            409,
            'SUBSCRIPTIONS_SNAPSHOT_CHANGED',
            'Список изменился. Обновите его с первой страницы.',
          );
        }
        return sendApiError(
          request,
          reply,
          503,
          'SUBSCRIPTIONS_READ_UNAVAILABLE',
          'Полный список абонементов временно недоступен.',
        );
      }
    },
  );
}
