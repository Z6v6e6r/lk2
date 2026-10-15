import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import Fastify from 'fastify';
import YAML from 'yaml';
import { describe, expect, it } from 'vitest';

const ticket = {
  id: '11111111-1111-4111-8111-111111111111',
  subject: 'Synthetic issue',
  category: 'TECHNICAL',
  status: 'CLOSED',
  priority: 'NORMAL',
  assignedTo: null,
  tags: [],
  version: 1,
  createdAt: '2026-10-11T12:00:00.000Z',
  updatedAt: '2026-10-11T12:00:00.000Z',
  resolvedAt: null,
  autoCloseAt: null,
  closedAt: '2026-10-11T12:00:00.000Z',
  conversationPurgedAt: null,
  messages: [
    {
      id: '22222222-2222-4222-8222-222222222222',
      body: 'Synthetic reply',
      authorRole: 'AGENT',
      internal: false,
      createdAt: '2026-10-11T12:00:00.000Z',
    },
  ],
  history: [
    {
      id: '33333333-3333-4333-8333-333333333333',
      kind: 'support.ticket.closed.v1',
      createdAt: '2026-10-11T12:00:00.000Z',
    },
  ],
};
describe('support OpenAPI response contract', () => {
  it('validates emitted detail/list shapes and rejects staff fields/notes in every user view', async () => {
    const contract: unknown = YAML.parse(
      await readFile(
        resolve(import.meta.dirname, '../../../../contracts/openapi/common/support-tickets.yaml'),
        'utf8',
      ),
    );
    if (typeof contract !== 'object' || contract === null)
      throw new Error('SUPPORT_CONTRACT_INVALID');
    // Reuse the installed API JSON-schema validator; no separate test-only validator dependency.
    const app = Fastify({ ajv: { customOptions: { strictSchema: false } } });
    app.addSchema({ $id: 'support-response-contract', ...contract });
    for (const name of ['UserTicket', 'Ticket', 'UserTicketPage', 'TicketPage'])
      app.post(
        '/' + name,
        { schema: { body: { $ref: 'support-response-contract#/components/schemas/' + name } } },
        () => Promise.resolve({ valid: true }),
      );
    try {
      expect(
        (await app.inject({ method: 'POST', url: '/UserTicket', payload: ticket })).statusCode,
      ).toBe(200);
      const withoutThread: Record<string, unknown> = { ...ticket };
      delete withoutThread.messages;
      delete withoutThread.history;
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/UserTicketPage',
            payload: { items: [withoutThread] },
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/TicketPage',
            payload: {
              items: [
                {
                  ...withoutThread,
                  messages: [],
                  history: [],
                  assignedTo: ticket.id,
                  tags: ['triage'],
                },
              ],
            },
          })
        ).statusCode,
      ).toBe(200);
      for (const fields of [
        { assignedTo: ticket.id },
        { tags: ['private-label'] },
        { messages: [{ ...ticket.messages[0], internal: true }] },
        { history: [{ ...ticket.history[0], kind: 'support.ticket.internal_note.v1' }] },
      ]) {
        expect(
          (
            await app.inject({
              method: 'POST',
              url: '/UserTicket',
              payload: { ...ticket, ...fields },
            })
          ).statusCode,
        ).toBe(400);
        expect(
          (
            await app.inject({
              method: 'POST',
              url: '/UserTicketPage',
              payload: { items: [{ ...withoutThread, ...fields }] },
            })
          ).statusCode,
        ).toBe(400);
      }
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/Ticket',
            payload: {
              ...ticket,
              assignedTo: ticket.id,
              tags: ['triage'],
              messages: [{ ...ticket.messages[0], internal: true }],
              history: [{ ...ticket.history[0], kind: 'support.ticket.internal_note.v1' }],
            },
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/UserTicket',
            payload: {
              ...ticket,
              messages: [],
              conversationPurgedAt: '2028-10-11T12:00:00.000Z',
              history: [{ ...ticket.history[0], kind: 'support.ticket.conversation_purged.v1' }],
            },
          })
        ).statusCode,
      ).toBe(200);
    } finally {
      await app.close();
    }
  });
});
