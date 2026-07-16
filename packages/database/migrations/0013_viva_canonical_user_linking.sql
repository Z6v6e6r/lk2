-- Expand identity linking so one canonical Viva client can authenticate through
-- more than one Keycloak/social-provider subject without creating PadlHub users.
-- The canonical Viva profile mapping remains unique in integration.external_entity_map.

alter table integration.external_identity_map
  drop constraint if exists external_identities_tenant_id_user_id_issuer_key;

create index if not exists external_identity_map_user_issuer_idx
  on integration.external_identity_map (tenant_id, user_id, issuer);
