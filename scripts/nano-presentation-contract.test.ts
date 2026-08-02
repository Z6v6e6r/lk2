import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

function repositoryFile(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), 'utf8');
}

const caddyfile = repositoryFile('deploy/jetson/tls-ingress/Caddyfile');
const activation = repositoryFile('deploy/jetson/activate-live-home.sh');
const verification = repositoryFile('deploy/jetson/verify-live-staging-data.sh');
const cupVerification = repositoryFile('deploy/jetson/verify-cup-integrations.sh');

describe('Nano presentation release contract', () => {
  it('moves the Viva callback to HTTPS before the API consumes it', () => {
    const legacyIpSite = caddyfile.match(/http:\/\/185\.155\.18\.146 \{([\s\S]*?)\n\}/)?.[1];

    expect(legacyIpSite).toBeDefined();
    expect(legacyIpSite).toContain('@viva_callback path /user/api/v1/*/auth/viva/callback');
    expect(legacyIpSite).toContain('redir @viva_callback https://lk.nano.padlhub.su{uri} 302');
    expect(legacyIpSite).toContain('redir https://lk.nano.padlhub.su{uri} permanent');
    expect(legacyIpSite).not.toContain('reverse_proxy');
  });

  it('keeps CUP API calls same-origin and limits the PadlHub route set', () => {
    expect(caddyfile).toContain('@padlhub_api path /user/api/* /admin/api/* /public/api/*');
    expect(caddyfile).toMatch(/handle @padlhub_api\s*\{\s*reverse_proxy api:3000\s*}/);
    expect(caddyfile).toMatch(/handle\s*\{\s*reverse_proxy showcase-proxy:80\s*}/);
  });

  it('activates browser read jobs only with a usable mixed routing envelope', () => {
    expect(activation).toContain("printf 'VIVA_DIRECT_READ_ENABLED=true\\n'");
    expect(activation).toContain("plan.mode = 'MIXED_END_USER_READS'");
    expect(activation).toContain("plan.direct_read_operations @> array['profile.read']::text[]");
    expect(activation).toContain("binding.provider = 'VIVA'");
    expect(verification).toContain('require_value VIVA_DIRECT_READ_ENABLED true');
    expect(verification).toContain('routing_ready_delegations');
  });

  it('bounds communities and activates all four independent CUP placements', () => {
    expect(activation).toContain("printf 'COMMUNITIES_LEGACY_TIMEOUT_MS=2500\\n'");
    expect(activation).toContain("printf 'COMMUNITIES_LEGACY_MAX_ATTEMPTS=1\\n'");
    expect(activation).toContain('PROMOTIONS_HERO_PLACEMENT=cabinet_home_top');
    expect(activation).toContain('PROMOTIONS_RECOMMENDATION_STRIP_PLACEMENT=cabinet_for_me_strip');
    expect(activation).toContain('PROMOTIONS_RECOMMENDATION_CARD_PLACEMENT=cabinet_for_me_card');
    expect(verification).toContain("['cabinet_home_top', '/api/advertising/cabinet-home-top']");
    expect(verification).toContain(
      "['cabinet_for_me_card', '/api/advertising/cabinet-for-me-card']",
    );
  });

  it('requires same-origin CUP notifications, tenant authorization and shared engagement key', () => {
    expect(cupVerification).toContain(
      'PADLHUB_NOTIFICATION_API_BASE_URL https://cup.nano.padlhub.su',
    );
    expect(cupVerification).toContain("'notifications.manage' = any(access.permissions)");
    expect(cupVerification).toContain('cup_engagement_secret" != "$api_engagement_secret');
    expect(cupVerification).not.toContain('echo "$api_engagement_secret"');
  });
});
