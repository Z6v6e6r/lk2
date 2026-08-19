import { describe, expect, it } from 'vitest';

import { eligibilityPaymentAclProvisionStatements } from './provision-eligibility-payment-acl-boundary.js';

describe('eligibility/payment ACL provisioner', () => {
  it('prepares only the two exact schemas before migration', () => {
    const statements = eligibilityPaymentAclProvisionStatements({
      phase: 'pre',
      runtimeRoleName: 'phub_runtime',
    });
    expect(statements).toEqual([
      'create schema if not exists eligibility authorization current_user',
      'revoke all privileges on schema "eligibility" from public',
      'revoke all privileges on schema "eligibility" from "phub_runtime"',
      'grant usage on schema "eligibility" to "phub_runtime"',
      'revoke all privileges on schema "games" from public',
      'revoke all privileges on schema "games" from "phub_runtime"',
      'grant usage on schema "games" to "phub_runtime"',
    ]);
  });

  it('grants exact table privileges for the v2 projection matrix', () => {
    const statements = eligibilityPaymentAclProvisionStatements({
      phase: 'post',
      runtimeRoleName: 'phub_runtime',
    });
    expect(statements).toContain(
      'grant SELECT, INSERT, UPDATE on table "eligibility"."cup_player_level_projections" to "phub_runtime"',
    );
    expect(statements).toContain(
      'grant SELECT, INSERT on table "eligibility"."cup_player_level_projection_events" to "phub_runtime"',
    );
    expect(statements.join('\n')).not.toMatch(/\b(?:DELETE|TRUNCATE|REFERENCES|TRIGGER)\b/u);
  });

  it('quotes the runtime role as an identifier', () => {
    const statements = eligibilityPaymentAclProvisionStatements({
      phase: 'pre',
      runtimeRoleName: 'runtime"role',
    });
    expect(statements).toContain('grant usage on schema "eligibility" to "runtime""role"');
  });
});
