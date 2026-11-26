import { randomUUID } from 'node:crypto';

import { SignJWT } from 'jose';
import { z } from 'zod';

export const cupSupportHandoffBody = z
  .object({
    draft: z
      .string()
      .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
  })
  .strict();

export type CupSupportHandoffIssuer = (
  subject: string,
  draft: string,
  accessExpiresAt: number,
) => Promise<string | undefined>;

export function loadCupSupportHandoffIssuer(
  environment: NodeJS.ProcessEnv,
): CupSupportHandoffIssuer | undefined {
  if (environment.CUP_SUPPORT_STAGING_HANDOFF_ENABLED !== 'true') return undefined;

  const encoded = environment.CUP_SUPPORT_STAGING_HANDOFF_SECRET ?? '';
  const key = Buffer.from(encoded, 'base64url');
  if (
    key.length < 32 ||
    key.toString('base64url') !== encoded ||
    [environment.JWT_ACCESS_SECRET, environment.JWT_REFRESH_SECRET].some(
      (credential) =>
        credential && (encoded === credential || key.equals(Buffer.from(credential, 'utf8'))),
    )
  ) {
    throw new Error('CUP Support STAGING handoff requires a distinct canonical base64url key');
  }

  return async (subject, draft, accessExpiresAt) => {
    const iat = Math.floor(Date.now() / 1000);
    const exp = Math.min(iat + 90, accessExpiresAt);
    if (exp <= iat) return undefined;

    return new SignJWT({ tenant: 'padlhub', draft })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer('lk2')
      .setAudience('cup-support-staging/intake')
      .setSubject(subject)
      .setIssuedAt(iat)
      .setExpirationTime(exp)
      .setJti(randomUUID())
      .sign(key);
  };
}
