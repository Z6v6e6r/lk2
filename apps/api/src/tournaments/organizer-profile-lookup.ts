import { createPublicKey, verify, type KeyObject } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  organizerLookupBody,
  organizerLookupHash,
  organizerLookupPath,
  organizerLookupScope,
  organizerLookupType,
  organizerUuid,
} from './organizer-profile-lookup-contract.js';

const claimsSchema = z
  .object({
    contract_version: z.literal(1),
    iss: z.string(),
    aud: z.string(),
    sub: z.string(),
    scope: z.literal(organizerLookupScope),
    tenant_id: organizerUuid,
    tenant_key: z.string(),
    method: z.literal('POST'),
    path: z.string(),
    request_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    correlation_id: organizerUuid,
    jti: organizerUuid,
    iat: z.number().int(),
    nbf: z.number().int(),
    exp: z.number().int(),
  })
  .strict();
export interface OrganizerLookupOptions {
  readonly issuer: string;
  readonly audience: string;
  readonly subject: string;
  readonly tenantId: string;
  readonly tenantKey: string;
  readonly publicKeys: ReadonlyMap<string, KeyObject>;
  readonly claimNonce: (key: string, ttlSeconds: number) => Promise<boolean>;
  readonly findProfile: (
    tenantId: string,
    tenantKey: string,
    userId: string,
  ) => Promise<{ userId: string; displayName: string; ownerTenantKey: string } | null>;
  readonly now?: () => number;
}
export function organizerPublicKey(pem: string): KeyObject {
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048)
    throw new Error('ORGANIZER_LOOKUP_KEY_INVALID');
  return key;
}
function decode(part: string): unknown {
  if (
    !/^[A-Za-z0-9_-]+$/.test(part) ||
    Buffer.from(part, 'base64url').toString('base64url') !== part
  )
    throw new Error('invalid');
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as unknown;
}
/** Separate-purpose service route. Neither ordinary user JWTs nor other delegation purposes enter it. */
export function registerOrganizerProfileLookup(
  app: FastifyInstance,
  options?: OrganizerLookupOptions,
): void {
  app.post(
    '/internal/api/v1/:tenantKey/tournament-organizer-profile-lookups',
    { bodyLimit: 2048 },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
      const fail = (status: number, code: string) =>
        reply.code(status).send({ code, correlationId: request.id });
      if (!options) return fail(503, 'TOURNAMENT_ORGANIZER_LOOKUP_DISABLED');
      const parsed = organizerLookupBody.safeParse(request.body);
      if (!parsed.success) return fail(400, 'TOURNAMENT_ORGANIZER_LOOKUP_INVALID');
      const tenantKey = (request.params as { tenantKey: string }).tenantKey;
      const correlation = request.headers['x-correlation-id'];
      const authorization = request.headers.authorization;
      const now = Math.floor((options.now?.() ?? Date.now()) / 1000);
      let claims: z.infer<typeof claimsSchema>;
      let kid: string;
      try {
        if (
          tenantKey !== options.tenantKey ||
          request.url !== organizerLookupPath(tenantKey) ||
          !organizerUuid.safeParse(correlation).success ||
          !authorization?.startsWith('Bearer ') ||
          authorization.length > 8192
        )
          throw new Error('invalid');
        const parts = authorization.slice(7).split('.');
        if (parts.length !== 3) throw new Error('invalid');
        const header = z
          .object({
            alg: z.literal('RS256'),
            typ: z.literal(organizerLookupType),
            kid: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
          })
          .strict()
          .parse(decode(parts[0]!));
        claims = claimsSchema.parse(decode(parts[1]!));
        kid = header.kid;
        const key = options.publicKeys.get(kid);
        if (
          !key ||
          !/^[A-Za-z0-9_-]+$/.test(parts[2]!) ||
          !verify(
            'RSA-SHA256',
            Buffer.from(`${parts[0]}.${parts[1]}`),
            key,
            Buffer.from(parts[2]!, 'base64url'),
          ) ||
          claims.iss !== options.issuer ||
          claims.aud !== options.audience ||
          claims.sub !== options.subject ||
          claims.tenant_id !== options.tenantId ||
          claims.tenant_key !== tenantKey ||
          claims.path !== organizerLookupPath(tenantKey) ||
          claims.request_sha256 !== organizerLookupHash(parsed.data) ||
          claims.correlation_id !== correlation ||
          claims.nbf !== claims.iat ||
          claims.iat > now ||
          claims.exp <= now ||
          claims.exp - claims.iat < 1 ||
          claims.exp - claims.iat > 30
        )
          throw new Error('invalid');
      } catch {
        return fail(403, 'TOURNAMENT_ORGANIZER_LOOKUP_FORBIDDEN');
      }
      try {
        // Domain-separated tenant/key nonce. Never use Redis as assignment truth.
        const key = `tournament-organizer-lookup:v1:${options.tenantId}:${kid}:${claims.jti}`;
        if (!(await options.claimNonce(key, claims.exp - now)))
          return fail(403, 'TOURNAMENT_ORGANIZER_LOOKUP_REPLAY');
        const profile = await options.findProfile(
          options.tenantId,
          tenantKey,
          parsed.data.selectedUserId,
        );
        if (!profile) return fail(409, 'TOURNAMENT_ORGANIZER_PROFILE_UNAVAILABLE');
        const completed = Math.floor((options.now?.() ?? Date.now()) / 1000);
        if (
          completed >= claims.exp ||
          profile.userId !== parsed.data.selectedUserId ||
          !profile.displayName ||
          profile.displayName.length > 200 ||
          !/^[A-Za-z0-9_-]{1,200}$/.test(profile.ownerTenantKey)
        )
          return fail(503, 'TOURNAMENT_ORGANIZER_LOOKUP_UNAVAILABLE');
        return reply.send({
          ...parsed.data,
          tenantId: options.tenantId,
          tenantKey,
          profile: { userId: profile.userId, displayName: profile.displayName },
          ownerTenantKey: profile.ownerTenantKey,
          checkedAt: new Date(completed * 1000).toISOString(),
          expiresAt: new Date(claims.exp * 1000).toISOString(),
        });
      } catch {
        return fail(503, 'TOURNAMENT_ORGANIZER_LOOKUP_UNAVAILABLE');
      }
    },
  );
}
