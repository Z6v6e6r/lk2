-- Additive default-OFF eligibility provisioning for tenants created after migration 0084.

set local lock_timeout = '5s';

create or replace function eligibility.provision_tenant_defaults()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  previous_tenant text := pg_catalog.current_setting('app.tenant_id', true);
begin
  if tg_op <> 'INSERT' or tg_relid <> 'identity.tenants'::regclass then
    raise exception 'ELIGIBILITY_TENANT_DEFAULTS_TRIGGER_CONTEXT_INVALID';
  end if;
  perform pg_catalog.set_config('app.tenant_id', new.id::text, true);

  insert into eligibility.canonical_levels (
    tenant_id, sport_code, code, title, rank, sort_order, aliases, scale_version
  )
  select new.id, 'PADEL', level.code, level.title, level.rank, level.rank, level.aliases, 1
    from (values
      ('D', 'D', 1, array['D']::text[]),
      ('D+', 'D+', 2, array['D+']::text[]),
      ('C', 'C', 3, array['C']::text[]),
      ('C+', 'C+', 4, array['C+']::text[]),
      ('B', 'B', 5, array['B']::text[]),
      ('B+', 'B+', 6, array['B+']::text[]),
      ('A', 'A', 7, array['A']::text[])
    ) as level(code, title, rank, aliases)
  ;

  insert into eligibility.level_policies (
    tenant_id, sport_code, activity_type, mode, version, change_comment
  )
  select new.id, 'PADEL', activity.activity_type, 'OFF', 1, 'Safe initial policy'
    from (values ('GAME'), ('TOURNAMENT'), ('TRAINING')) as activity(activity_type)
  ;

  insert into eligibility.activation_readiness (tenant_id, sport_code, activity_type)
  select new.id, 'PADEL', activity.activity_type
    from (values ('GAME'), ('TOURNAMENT'), ('TRAINING')) as activity(activity_type)
  ;

  perform pg_catalog.set_config('app.tenant_id', coalesce(previous_tenant, ''), true);
  return new;
end;
$$;

revoke all on function eligibility.provision_tenant_defaults() from public;

do $function_acl$
declare
  unauthorized_execute_count integer;
  function_shape_count integer;
begin
  select count(*) into unauthorized_execute_count
    from pg_catalog.pg_proc procedure
    cross join lateral pg_catalog.aclexplode(
      coalesce(
        procedure.proacl,
        pg_catalog.acldefault('f', procedure.proowner)
      )
    ) privilege
   where procedure.oid = 'eligibility.provision_tenant_defaults()'::regprocedure
     and privilege.privilege_type = 'EXECUTE'
     and privilege.grantee <> procedure.proowner;

  select count(*) into function_shape_count
    from pg_catalog.pg_proc procedure
   where procedure.oid = 'eligibility.provision_tenant_defaults()'::regprocedure
     and procedure.prosecdef
     and procedure.proconfig = array['search_path=""']::text[];

  if unauthorized_execute_count <> 0 or function_shape_count <> 1 then
    raise exception 'ELIGIBILITY_TENANT_DEFAULTS_FUNCTION_ACL_INVALID:%:%',
      unauthorized_execute_count, function_shape_count;
  end if;
end;
$function_acl$;

create trigger eligibility_provision_tenant_defaults
after insert on identity.tenants
for each row execute function eligibility.provision_tenant_defaults();

do $trigger_shape$
declare
  related_trigger_count integer;
  trigger_shape_count integer;
begin
  select count(*), count(*) filter (
    where trigger.tgname = 'eligibility_provision_tenant_defaults'
      and trigger.tgfoid = 'eligibility.provision_tenant_defaults()'::regprocedure
      and trigger.tgtype = 5
      and trigger.tgenabled = 'O'
      and trigger.tgnargs = 0
  ) into related_trigger_count, trigger_shape_count
    from pg_catalog.pg_trigger trigger
   where trigger.tgrelid = 'identity.tenants'::regclass
     and not trigger.tgisinternal
     and (
       trigger.tgfoid = 'eligibility.provision_tenant_defaults()'::regprocedure
       or trigger.tgname = 'eligibility_provision_tenant_defaults'
     );
  if related_trigger_count <> 1 or trigger_shape_count <> 1 then
    raise exception 'ELIGIBILITY_TENANT_DEFAULTS_TRIGGER_SHAPE_INVALID:%:%',
      related_trigger_count, trigger_shape_count;
  end if;
end;
$trigger_shape$;

do $backfill$
declare
  tenant record;
  previous_tenant text := pg_catalog.current_setting('app.tenant_id', true);
  level_count integer;
  canonical_mismatch_count integer;
  policy_count integer;
  readiness_count integer;
begin
  for tenant in select id from identity.tenants order by id loop
    perform pg_catalog.set_config('app.tenant_id', tenant.id::text, true);

    select count(*) into level_count
      from eligibility.canonical_levels
     where tenant_id = tenant.id and sport_code = 'PADEL' and scale_version = 1 and active;
    with expected(code, rank) as (
      values ('D', 1), ('D+', 2), ('C', 3), ('C+', 4), ('B', 5), ('B+', 6), ('A', 7)
    ), actual as (
      select code, rank
        from eligibility.canonical_levels
       where tenant_id = tenant.id and sport_code = 'PADEL' and scale_version = 1 and active
    )
    select count(*) into canonical_mismatch_count
      from (
        (select * from expected except select * from actual)
        union all
        (select * from actual except select * from expected)
      ) difference;
    select count(*) into policy_count
      from eligibility.level_policies
     where tenant_id = tenant.id and sport_code = 'PADEL' and active;
    select count(*) into readiness_count
      from eligibility.activation_readiness
     where tenant_id = tenant.id and sport_code = 'PADEL';

    if level_count = 7 and canonical_mismatch_count = 0
       and policy_count = 3 and readiness_count = 3 then
      continue;
    end if;
    if level_count <> 0 or policy_count <> 0 or readiness_count <> 0 then
      raise exception 'ELIGIBILITY_TENANT_DEFAULTS_PARTIAL:%:%:%:%',
        tenant.id, level_count, policy_count, readiness_count;
    end if;

    insert into eligibility.canonical_levels (
      tenant_id, sport_code, code, title, rank, sort_order, aliases, scale_version
    )
    select tenant.id, 'PADEL', level.code, level.title, level.rank, level.rank, level.aliases, 1
      from (values
        ('D', 'D', 1, array['D']::text[]),
        ('D+', 'D+', 2, array['D+']::text[]),
        ('C', 'C', 3, array['C']::text[]),
        ('C+', 'C+', 4, array['C+']::text[]),
        ('B', 'B', 5, array['B']::text[]),
        ('B+', 'B+', 6, array['B+']::text[]),
        ('A', 'A', 7, array['A']::text[])
      ) as level(code, title, rank, aliases)
    ;

    insert into eligibility.level_policies (
      tenant_id, sport_code, activity_type, mode, version, change_comment
    )
    select tenant.id, 'PADEL', activity.activity_type, 'OFF', 1, 'Safe initial policy'
      from (values ('GAME'), ('TOURNAMENT'), ('TRAINING')) as activity(activity_type)
    ;

    insert into eligibility.activation_readiness (tenant_id, sport_code, activity_type)
    select tenant.id, 'PADEL', activity.activity_type
      from (values ('GAME'), ('TOURNAMENT'), ('TRAINING')) as activity(activity_type)
    ;

    select count(*) into level_count
      from eligibility.canonical_levels
     where tenant_id = tenant.id and sport_code = 'PADEL' and scale_version = 1 and active;
    with expected(code, rank) as (
      values ('D', 1), ('D+', 2), ('C', 3), ('C+', 4), ('B', 5), ('B+', 6), ('A', 7)
    ), actual as (
      select code, rank
        from eligibility.canonical_levels
       where tenant_id = tenant.id and sport_code = 'PADEL' and scale_version = 1 and active
    )
    select count(*) into canonical_mismatch_count
      from (
        (select * from expected except select * from actual)
        union all
        (select * from actual except select * from expected)
      ) difference;
    select count(*) into policy_count
      from eligibility.level_policies
     where tenant_id = tenant.id and sport_code = 'PADEL' and active and mode = 'OFF';
    select count(*) into readiness_count
      from eligibility.activation_readiness
     where tenant_id = tenant.id and sport_code = 'PADEL'
       and not writer_authoritative and not player_projection_ready
       and not client_recovery_ready and not payment_recovery_ready;
    if level_count <> 7 or canonical_mismatch_count <> 0
       or policy_count <> 3 or readiness_count <> 3 then
      raise exception 'ELIGIBILITY_TENANT_DEFAULTS_POSTCONDITION_FAILED:%', tenant.id;
    end if;
  end loop;

  perform pg_catalog.set_config('app.tenant_id', coalesce(previous_tenant, ''), true);
end;
$backfill$;
