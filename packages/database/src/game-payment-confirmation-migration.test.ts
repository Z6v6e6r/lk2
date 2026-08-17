import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('game payment confirmation evidence migration', () => {
  it('binds one trusted provider operation to one eligibility-backed reservation', async () => {
    const sql = await readFile(
      new URL('../migrations/0085_game_payment_confirmation_evidence.sql', import.meta.url),
      'utf8',
    );

    expect(sql).toContain('create table games.payment_confirmation_evidence');
    expect(sql).toContain("provider_operation_type in ('TRANSACTION', 'SUBSCRIPTION_BOOKING')");
    expect(sql).toContain(
      'unique (tenant_id, provider, provider_operation_type, provider_operation_id)',
    );
    expect(sql).toContain('unique (tenant_id, reservation_id)');
    expect(sql).toContain('provider_booking_id text not null');
    expect(sql).toContain('client_phone_e164 text not null');
    expect(sql).toContain('references eligibility.decisions(tenant_id, id)');
    expect(sql).toContain('enable row level security');
    expect(sql).toContain('force row level security');
  });

  it('adds an expand-only provider exercise binding for trusted evidence', async () => {
    const sql = await readFile(
      new URL('../migrations/0086_game_payment_provider_exercise_binding.sql', import.meta.url),
      'utf8',
    );

    expect(sql).toContain('add column if not exists provider_exercise_id text');
    expect(sql).toContain('provider_exercise_id is null');
    expect(sql).toContain('char_length(btrim(provider_exercise_id)) between 1 and 200');
    expect(sql).toContain('validate constraint payment_confirmation_evidence_provider_exercise_id_check');
  });
});
