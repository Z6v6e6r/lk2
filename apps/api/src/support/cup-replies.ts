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
    ticketId: z.string().uuid(),
    status: z.enum([
      'OPEN',
      'IN_PROGRESS',
      'WAITING_USER',
      'WAITING_DEVELOPMENT',
      'RESOLVED',
      'CLOSED',
    ]),
    kind: z.enum(['CUSTOMER', 'STAFF_REPLY']),
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

export const cupReplyCommand = z
  .object({
    ticketId: z.string().uuid(),
    body: z
      .string()
      .trim()
      .min(1)
      .max(4000)
      .refine((text) => !text.includes('\0')),
  })
  .strict();
export const cupReplyCommandKey = z.string().uuid();
const sentMessage = z.object({ id: z.string().uuid() }).strict();

export type CupReplyWriter = (
  recipient: string,
  command: z.infer<typeof cupReplyCommand>,
  idempotencyKey: string,
) => Promise<z.infer<typeof sentMessage>>;

export class CupReplyRejected extends Error {
  constructor(readonly status: 404 | 409) {
    super('CUP rejected the message');
  }
}

export function loadCupConversation(
  environment: NodeJS.ProcessEnv,
  request = fetch,
): { read: CupReplyReader; write: CupReplyWriter; pilotUserId: string } | undefined {
  if (environment.CUP_SUPPORT_STAGING_REPLIES_ENABLED !== 'true') return undefined;
  const endpoint = new URL(environment.CUP_SUPPORT_STAGING_REPLIES_URL ?? '');
  const tokenFile = environment.CUP_SUPPORT_STAGING_REPLIES_TOKEN_FILE;
  const pilot = z.string().uuid().safeParse(environment.CUP_SUPPORT_STAGING_REPLIES_PILOT_USER_ID);
  if (
    endpoint.origin !== 'https://cup-replies-private.tsup.space:19446' ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== '/internal/cup/v1/lk2/replies' ||
    !tokenFile ||
    !pilot.success
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
  async function send(path: URL, payload: object) {
    return request(path, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      redirect: 'error',
      signal: AbortSignal.timeout(4_000),
      cache: 'no-store',
    });
  }
  async function readBody(response: Response, byteLimit: number): Promise<unknown> {
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
        if (size > byteLimit) throw new Error('CUP reply history too large');
        chunks.push(value);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } finally {
      await reader.cancel();
    }
  }
  const read: CupReplyReader = async (recipient, before) =>
    page.parse(await readBody(await send(endpoint, { recipient, before }), 1_048_576));
  const write: CupReplyWriter = async (recipient, command, idempotencyKey) => {
    const response = await send(new URL('messages', endpoint), {
      recipient,
      body: command.body,
      ticketId: command.ticketId.toLowerCase(),
      idempotencyKey: idempotencyKey.toLowerCase(),
    });
    if (response.status !== 201) {
      await response.body?.cancel();
      if (response.status === 404 || response.status === 409)
        throw new CupReplyRejected(response.status);
      throw new Error('CUP reply service unavailable');
    }
    return sentMessage.parse(await readBody(response, 1024));
  };
  return { read, write, pilotUserId: pilot.data.toLowerCase() };
}
