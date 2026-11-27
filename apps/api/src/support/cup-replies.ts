import { readFileSync } from 'node:fs';
import { z } from 'zod';

export const cupReplyCursor = z
  .object({
    at: z.string().datetime(),
    id: z.string().uuid(),
  })
  .strict();

const message = z
  .object({
    id: z.string().uuid(),
    number: z.string().min(1).max(80),
    body: z.string().min(1).max(16_000),
    createdAt: z.string().datetime(),
  })
  .strict();
const page = z
  .object({ messages: z.array(message).max(40), next: cupReplyCursor.nullable() })
  .strict();

export type CupReplyReader = (
  recipient: string,
  before?: z.infer<typeof cupReplyCursor>,
) => Promise<z.infer<typeof page>>;

export function loadCupReplyReader(
  environment: NodeJS.ProcessEnv,
  request = fetch,
): CupReplyReader | undefined {
  if (environment.CUP_SUPPORT_STAGING_REPLIES_ENABLED !== 'true') return undefined;
  const endpoint = new URL(environment.CUP_SUPPORT_STAGING_REPLIES_URL ?? '');
  const tokenFile = environment.CUP_SUPPORT_STAGING_REPLIES_TOKEN_FILE;
  if (
    endpoint.origin !== 'https://cup-replies-private.tsup.space:19445' ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== '/internal/cup/v1/lk2/replies' ||
    !tokenFile
  ) {
    throw new Error('Invalid CUP replies service configuration');
  }
  const token = readFileSync(tokenFile, 'utf8').trim();
  const reused = [
    environment.JWT_ACCESS_SECRET,
    environment.JWT_REFRESH_SECRET,
    environment.CUP_SUPPORT_STAGING_HANDOFF_SECRET,
    Buffer.from(token, 'hex').toString('base64url'),
  ];
  if (
    !/^[a-f0-9]{64}$/.test(token) ||
    reused.slice(0, 3).includes(token) ||
    environment.CUP_SUPPORT_STAGING_HANDOFF_SECRET === reused[3]
  ) {
    throw new Error('CUP replies require a dedicated service credential');
  }
  return async (recipient, before) => {
    const response = await request(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient, before }),
      redirect: 'error',
      signal: AbortSignal.timeout(4_000),
      cache: 'no-store',
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error('CUP reply history unavailable');
    }
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 1_048_576) throw new Error('CUP reply history too large');
        chunks.push(value);
      }
      return page.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    } finally {
      await reader.cancel();
    }
  };
}
