-- Disposable test stand only: open the default-off tenant gates for the synthetic local-padel
-- tenant so in-app notifications and chats can be tested. Real tenants use the audited
-- `npm run notifications:runtime:set` / `npm run messaging:runtime:set` commands instead.
-- Push channels and booking reminders stay off. Idempotent; applied by deploy.sh after migrations.

insert into notifications.tenant_runtime_settings (tenant_id, in_app_enabled)
select id, true from identity.tenants where tenant_key = 'local-padel'
on conflict (tenant_id) do update set in_app_enabled = true, updated_at = now();

insert into messaging.tenant_runtime_settings (
  tenant_id, http_enabled, direct_enabled, realtime_enabled, contextual_enabled
)
select id, true, true, true, true from identity.tenants where tenant_key = 'local-padel'
on conflict (tenant_id) do update set
  http_enabled = true,
  direct_enabled = true,
  realtime_enabled = true,
  contextual_enabled = true,
  updated_at = now();
