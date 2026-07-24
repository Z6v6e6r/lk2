import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('gift certificate catalog migration', () => {
  it('creates a local-primary tenant boundary with forced RLS', async () => {
    const sql = await readFile(
      resolve(process.cwd(), 'packages/database/migrations/0028_gift_certificate_catalog.sql'),
      'utf8',
    );

    for (const table of ['catalog_versions', 'designs', 'denominations', 'admin_commands']) {
      expect(sql).toContain(`alter table gift_certificates.${table} enable row level security;`);
      expect(sql).toContain(`alter table gift_certificates.${table} force row level security;`);
    }
    expect(sql).toContain("'gift_certificates', 'LOCAL_PRIMARY'");
  });

  it('keeps money server-owned and excludes order or activation secrets from this slice', async () => {
    const sql = await readFile(
      resolve(process.cwd(), 'packages/database/migrations/0028_gift_certificate_catalog.sql'),
      'utf8',
    );

    expect(sql).toContain('amount_minor bigint not null');
    expect(sql).toContain("currency text not null check (currency = 'RUB')");
    expect(sql).not.toMatch(/activation_token|payment_url|provider_id|recipient_email/i);
  });

  it('adds sale, payment and media tables behind forced tenant RLS', async () => {
    const sql = await readFile(
      resolve(process.cwd(), 'packages/database/migrations/0029_gift_certificate_sale_sandbox.sql'),
      'utf8',
    );

    for (const table of [
      'media_assets',
      'media_commands',
      'purchase_sessions',
      'orders',
      'sale_commands',
    ]) {
      expect(sql).toContain(`alter table gift_certificates.${table} enable row level security;`);
      expect(sql).toContain(`alter table gift_certificates.${table} force row level security;`);
    }
    expect(sql).toContain('alter table commerce.payment_operations enable row level security;');
    expect(sql).toContain('alter table commerce.payment_operations force row level security;');
    expect(sql).toContain("provider text not null check (provider = 'PADLHUB_SANDBOX')");
    expect(sql).toContain('amount_minor bigint not null');
    expect(sql).toContain('design_snapshot jsonb not null');
    expect(sql).toContain('policy_snapshot jsonb not null');
  });

  it('adds exactly-once issuance artifacts and delivery behind forced tenant RLS', async () => {
    const sql = await readFile(
      resolve(process.cwd(), 'packages/database/migrations/0030_gift_certificate_issuance.sql'),
      'utf8',
    );

    for (const table of ['certificates', 'artifacts', 'deliveries']) {
      expect(sql).toContain(`alter table gift_certificates.${table} enable row level security;`);
      expect(sql).toContain(`alter table gift_certificates.${table} force row level security;`);
    }
    expect(sql).toContain('unique (tenant_id, order_id)');
    expect(sql).toContain('activation_token_digest text not null');
    expect(sql).not.toMatch(/activation_token\s+text/i);
    expect(sql).toContain("content_type = 'application/pdf'");
    expect(sql).toContain("status in ('PENDING', 'SANDBOXED', 'DELIVERED', 'FAILED')");
  });

  it('adds bounded per-design overlay coordinates without rewriting existing rows', async () => {
    const sql = await readFile(
      resolve(
        process.cwd(),
        'packages/database/migrations/0032_gift_certificate_design_overlay_coordinates.sql',
      ),
      'utf8',
    );

    for (const column of [
      'code_x_percent',
      'code_y_percent',
      'amount_x_percent',
      'amount_y_percent',
    ]) {
      expect(sql).toContain(`add column ${column}`);
      expect(sql).toContain(`check (${column} between 0 and 100)`);
    }
  });
});
