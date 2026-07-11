-- Pre-release boundary correction: provider bindings and external subjects are
-- integration data. Moving the existing tables preserves their OIDs, rows,
-- constraints and RLS policies without copying identifiers into another store.

alter table identity.tenant_auth_config set schema integration;
alter table integration.tenant_auth_config rename to identity_provider_bindings;

alter table identity.external_identities set schema integration;
alter table integration.external_identities rename to external_identity_map;

select set_config(
  'app.tenant_id',
  (select id::text from identity.tenants where tenant_key = 'local-padel'),
  true
);

insert into integration.domain_ownership (
  tenant_id,
  domain_name,
  ownership_mode,
  rollback_mode
)
select id, domain_name, 'VIVA_PRIMARY', 'VIVA_PRIMARY'
from identity.tenants
cross join (values ('identity_authentication'), ('profile')) as domains(domain_name)
where tenant_key = 'local-padel'
on conflict (tenant_id, domain_name) do nothing;
