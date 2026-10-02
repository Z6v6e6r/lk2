import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { createContactRepository } from './contact-repository.js';

describe('profile contacts boundary', () => {
  it('adds only an expand-only tenant-scoped table and a non-unique shared-value lookup', async () => {
    const sql = await readFile(
      resolve(process.cwd(), 'packages/database/migrations/0096_profile_contacts.sql'),
      'utf8',
    );
    expect(sql).toContain(
      'foreign key (tenant_id, user_id) references identity.users(tenant_id, id)',
    );
    expect(sql).toContain('unique (tenant_id, user_id, type, normalized_value)');
    expect(sql).toContain('on profile.contacts (tenant_id, type, normalized_value)');
    expect(sql).toContain('alter table profile.contacts force row level security');
    expect(sql).toContain('alter table profile.contact_commands force row level security');
    expect(sql).toContain('create trigger contacts_identity_immutable');
    expect(sql).not.toMatch(/\bverified_at\b|\bverification_source\b/);
    expect(sql.match(/-- phub:reviewed-new-table-index/g)).toHaveLength(1);
    expect(sql).not.toMatch(/drop\s+(?:table|column)|truncate|alter\s+column/i);
    expect(sql).not.toMatch(/unique\s*\(tenant_id,\s*type,\s*normalized_value\)/i);
  });

  it('rejects proof fields and non-normalized values before a database call', async () => {
    const repository = createContactRepository({} as Pool);
    const base = {
      tenantId: randomUUID(),
      actorId: randomUUID(),
      userId: randomUUID(),
      correlationId: 'synthetic-correlation',
      idempotencyKey: 'synthetic-contact-key-0001',
      type: 'PHONE' as const,
      normalizedValue: '+79990000001',
      sourceKind: 'LOCAL' as const,
    };
    await expect(
      repository.create({ ...base, verifiedAt: new Date() } as typeof base),
    ).rejects.toThrow('CONTACT_INPUT_INVALID');
    await expect(
      repository.create({ ...base, verification_source: 'claimed' } as typeof base),
    ).rejects.toThrow('CONTACT_INPUT_INVALID');
    await expect(
      repository.create({ ...base, normalizedValue: '8 (999) 000-00-01' }),
    ).rejects.toThrow('CONTACT_VALUE_NOT_NORMALIZED');
    await expect(
      repository.create({ ...base, type: 'EMAIL', normalizedValue: 'Example@EXAMPLE.test' }),
    ).rejects.toThrow('CONTACT_VALUE_NOT_NORMALIZED');
    await expect(
      repository.updateProvenance({
        tenantId: base.tenantId,
        actorId: base.actorId,
        correlationId: base.correlationId,
        idempotencyKey: 'synthetic-contact-key-0002',
        contactId: randomUUID(),
        expectedVersion: 1,
        sourceKind: 'VIVA',
        verified_at: new Date().toISOString(),
      } as never),
    ).rejects.toThrow('CONTACT_INPUT_INVALID');
  });
});
