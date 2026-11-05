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

-- Two published synthetic stations so games can be created (an admin normally publishes them).
-- They are owned by a fixed synthetic operator user that never signs in.
insert into identity.users (id, tenant_id)
select '00000000-0000-4000-8000-00000000a001', id from identity.tenants where tenant_key = 'local-padel'
on conflict do nothing;

insert into locations.profiles (
  tenant_id, id, slug, title, short_title, city, court_count, address, latitude, longitude,
  metro_name, publication_status, show_on_home, sort_order, created_by, updated_by, published_at
)
select t.id, v.id::uuid, v.slug, v.title, v.short_title, 'Москва', v.courts, v.address, v.lat, v.lon,
       v.metro, 'PUBLISHED', true, v.sort, '00000000-0000-4000-8000-00000000a001',
       '00000000-0000-4000-8000-00000000a001', now()
  from identity.tenants t
 cross join (values
   ('00000000-0000-4000-8000-00000000b001', 'stand-north', 'Тестовая станция Север', 'Север', 4,
    'Москва, ул. Тестовая, 1', 55.835000, 37.625000, 'ВДНХ', 1),
   ('00000000-0000-4000-8000-00000000b002', 'stand-south', 'Тестовая станция Юг', 'Юг', 3,
    'Москва, ул. Тестовая, 2', 55.655000, 37.615000, 'Южная', 2)
 ) as v(id, slug, title, short_title, courts, address, lat, lon, metro, sort)
 where t.tenant_key = 'local-padel'
on conflict do nothing;
