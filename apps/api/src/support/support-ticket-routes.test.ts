import Fastify, { type FastifyInstance } from 'fastify';
import {
  SupportTicketPermissionError,
  type SupportTicketRepository,
  type SupportTicketView,
} from '@phub/database';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerSupportTicketRoutes, supportCommandHash } from './support-ticket-routes.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';
const ticketId = '33333333-3333-4333-8333-333333333333';
const key = 'synthetic-command-00001';
const ticket = {
  id: ticketId,
  version: 1,
  messages: [],
  history: [],
} as unknown as SupportTicketView;
const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
function fixture(
  input: {
    authenticated?: boolean;
    admin?: boolean;
    permissions?: string[];
    outcome?: 'version_conflict' | 'not_found' | 'receipt_expired';
    revoked?: boolean;
  } = {},
) {
  const repository = {
    list: vi.fn(() => {
      if (input.revoked) return Promise.reject(new SupportTicketPermissionError());
      return Promise.resolve({ items: [ticket] });
    }),
    get: vi.fn(() => {
      if (input.revoked) return Promise.reject(new SupportTicketPermissionError());
      return Promise.resolve(input.outcome === 'not_found' ? undefined : ticket);
    }),
    create: vi.fn<SupportTicketRepository['create']>(() =>
      Promise.resolve({
        outcome: 'applied' as const,
        ticket,
        replayed: false,
      }),
    ),
    message: vi.fn<SupportTicketRepository['message']>(() =>
      Promise.resolve(
        input.outcome
          ? { outcome: input.outcome }
          : { outcome: 'applied' as const, ticket, replayed: false },
      ),
    ),
    update: vi.fn<SupportTicketRepository['update']>(() =>
      Promise.resolve({
        outcome: 'applied' as const,
        ticket,
        replayed: true,
      }),
    ),
    closeResolvedBatch: vi.fn(() => Promise.resolve(0)),
    purgeClosedBatch: vi.fn(() => Promise.resolve(0)),
  } satisfies SupportTicketRepository;
  const app = Fastify();
  apps.push(app);
  app.addHook('preHandler', (request, _reply, done) => {
    if (input.authenticated !== false) {
      request.tenantId = tenantId;
      request.padlHubClaims = {
        sub: userId,
        roles: [input.admin ? 'admin' : 'client'],
        permissions: input.permissions ?? ['support.read', 'support.manage'],
      } as never;
    }
    done();
  });
  registerSupportTicketRoutes(app, {
    repository,
    authenticatedTenantHandlers: [],
    commandHandlers: [],
    adminAuthenticatedTenantHandlers: [],
    adminCommandHandlers: [],
  });
  return { app, repository };
}
const userBase = '/user/api/v1/local-padel/support/tickets';
const adminBase = '/admin/api/v1/local-padel/support/tickets';
describe('support API boundaries', () => {
  it('requires authentication and scopes every user read to tenant and subject', async () => {
    const anonymous = fixture({ authenticated: false });
    expect((await anonymous.app.inject({ url: userBase })).statusCode).toBe(401);
    expect(anonymous.repository.list).not.toHaveBeenCalled();
    const { app, repository } = fixture();
    const response = await app.inject({ url: `${userBase}/${ticketId}` });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(repository.get).toHaveBeenCalledWith({
      tenantId,
      ticketId,
      ownerUserId: userId,
      admin: false,
    });
    expect(
      (await app.inject({ url: `${userBase}/${ticketId}?ownerUserId=${userId}` })).statusCode,
    ).toBe(400);
  });
  it.each([
    { platform: 'web', admin: true, permissions: ['support.read'] },
    { platform: 'cup-admin', admin: false, permissions: ['support.read'] },
    { platform: 'cup-admin', admin: true, permissions: [] },
  ])(
    'denies administrative reads outside client/role/permission gates',
    async ({ platform, admin, permissions }) => {
      const { app, repository } = fixture({ admin, permissions });
      expect(
        (await app.inject({ url: adminBase, headers: { 'x-app-platform': platform } })).statusCode,
      ).toBe(403);
      expect(repository.list).not.toHaveBeenCalled();
    },
  );
  it('passes the actor to DB read checks, accepts manage-only reads and denies freshly revoked grants', async () => {
    const active = fixture({ admin: true, permissions: ['support.manage'] });
    expect(
      (await active.app.inject({ url: adminBase, headers: { 'x-app-platform': 'cup-admin' } }))
        .statusCode,
    ).toBe(200);
    expect(active.repository.list).toHaveBeenCalledWith({
      tenantId,
      adminActorId: userId,
      limit: 20,
    });
    const revoked = fixture({ admin: true, revoked: true });
    expect(
      (
        await revoked.app.inject({
          url: `${adminBase}/${ticketId}`,
          headers: { 'x-app-platform': 'cup-admin' },
        })
      ).statusCode,
    ).toBe(403);
  });
  it('rejects internal-note injection and unknown fields in user commands', async () => {
    const { app, repository } = fixture();
    for (const payload of [
      { body: 'Synthetic', expectedVersion: 1, internal: true },
      { body: 'Synthetic', expectedVersion: 1, internal: false },
      { body: 'Synthetic', expectedVersion: 1, actorId: userId },
    ])
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `${userBase}/${ticketId}/messages`,
            headers: { 'idempotency-key': key },
            payload,
          })
        ).statusCode,
      ).toBe(400);
    expect(repository.message).not.toHaveBeenCalled();
  });
  it('maps stale versions to a stable conflict without changing the operation and preserves deterministic replay headers', async () => {
    const stale = fixture({ outcome: 'version_conflict' });
    const response = await stale.app.inject({
      method: 'POST',
      url: `${userBase}/${ticketId}/messages`,
      headers: { 'idempotency-key': key },
      payload: { body: 'Synthetic', expectedVersion: 1 },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json<{ code: string }>().code).toBe('SUPPORT_TICKET_VERSION_CONFLICT');
    const admin = fixture({ admin: true });
    const replay = await admin.app.inject({
      method: 'PATCH',
      url: `${adminBase}/${ticketId}`,
      headers: { 'idempotency-key': key, 'x-app-platform': 'cup-admin' },
      payload: { expectedVersion: 1, status: 'RESOLVED' },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.headers['x-idempotent-replayed']).toBe('true');
    expect(admin.repository.update.mock.calls[0]?.[0]).toMatchObject({
      requestHash: supportCommandHash('UPDATE', ticketId, {
        expectedVersion: 1,
        status: 'RESOLVED',
      }),
      actorId: userId,
      tenantId,
    });
  });
  it('uses strict bounded opaque cursors and hides unowned tickets as 404', async () => {
    const { app, repository } = fixture({ outcome: 'not_found' });
    expect((await app.inject({ url: `${userBase}?cursor=2026-10-11T00:00:00Z` })).statusCode).toBe(
      400,
    );
    expect((await app.inject({ url: `${userBase}?limit=51` })).statusCode).toBe(400);
    expect((await app.inject({ url: `${userBase}/${ticketId}` })).statusCode).toBe(404);
    expect(repository.list).not.toHaveBeenCalled();
  });
  it('requires manage permission for writes and supplies independent command hashes for all operations/targets', async () => {
    const readOnly = fixture({ admin: true, permissions: ['support.read'] });
    expect(
      (
        await readOnly.app.inject({
          method: 'PATCH',
          url: `${adminBase}/${ticketId}`,
          headers: { 'idempotency-key': key, 'x-app-platform': 'cup-admin' },
          payload: { expectedVersion: 1, priority: 'HIGH' },
        })
      ).statusCode,
    ).toBe(403);
    const body = { body: 'Synthetic', expectedVersion: 1 };
    const hash = supportCommandHash('USER_MESSAGE', ticketId, body);
    expect(
      supportCommandHash('USER_MESSAGE', ticketId, { expectedVersion: 1, body: 'Synthetic' }),
    ).toBe(hash);
    expect(supportCommandHash('ADMIN_MESSAGE', ticketId, body)).not.toBe(hash);
    expect(supportCommandHash('USER_MESSAGE', userId, body)).not.toBe(hash);
    expect(supportCommandHash('USER_MESSAGE', ticketId, { ...body, body: 'Changed' })).not.toBe(
      hash,
    );
    expect(supportCommandHash('UPDATE', ticketId, body)).not.toBe(hash);
  });
});

describe('support expired command receipt', () => {
  it('returns a stable410 without treating the ancient operation as a new mutation', async () => {
    const { app } = fixture({ outcome: 'receipt_expired' });
    const response = await app.inject({
      method: 'POST',
      url: `${userBase}/${ticketId}/messages`,
      headers: { 'idempotency-key': key },
      payload: { body: 'Synthetic reply', expectedVersion: 1 },
    });
    expect(response.statusCode).toBe(410);
    expect(response.json<{ code: string }>().code).toBe('SUPPORT_COMMAND_EXPIRED');
  });
});
