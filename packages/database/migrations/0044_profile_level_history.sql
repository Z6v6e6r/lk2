-- Immutable PadlHub-owned history of normalized player level changes.
-- Existing profiles receive one honest baseline point; later summary changes append through
-- the same transaction that updates profile.user_summaries.

create table profile.level_history (
  tenant_id uuid not null,
  id uuid not null default gen_random_uuid(),
  user_id uuid not null,
  level_label text not null
    check (level_label in ('D', 'D+', 'C', 'C+', 'B', 'B+', 'A')),
  level_value numeric(8, 5)
    check (level_value is null or (level_value >= 0 and level_value <= 10)),
  changed_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  source text not null default 'PROFILE_SUMMARY'
    check (source in ('PROFILE_SUMMARY', 'RATING_EVENT_BACKFILL')),
  primary key (tenant_id, id),
  foreign key (tenant_id, user_id) references identity.users(tenant_id, id)
);

create unique index profile_level_history_change_idx
  on profile.level_history (
    tenant_id,
    user_id,
    changed_at,
    level_label,
    coalesce(level_value, -1)
  );

create index profile_level_history_user_idx
  on profile.level_history (tenant_id, user_id, changed_at desc, id desc);

insert into profile.level_history (
  tenant_id,
  user_id,
  level_label,
  level_value,
  changed_at
)
select tenant_id, user_id, level_label, level_value, updated_at
  from profile.user_summaries
 where level_label is not null
on conflict do nothing;

alter table profile.level_history enable row level security;

create policy profile_level_history_tenant_isolation on profile.level_history
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table profile.level_history force row level security;

create or replace function profile.capture_level_history()
returns trigger
language plpgsql
as $$
begin
  if new.level_label is null then
    return new;
  end if;

  if tg_op = 'INSERT'
     or new.level_label is distinct from old.level_label
     or new.level_value is distinct from old.level_value then
    insert into profile.level_history (
      tenant_id,
      user_id,
      level_label,
      level_value,
      changed_at
    )
    values (
      new.tenant_id,
      new.user_id,
      new.level_label,
      new.level_value,
      coalesce(new.updated_at, now())
    )
    on conflict do nothing;
  end if;

  return new;
end;
$$;

drop trigger if exists profile_user_summary_level_history on profile.user_summaries;

create trigger profile_user_summary_level_history
after insert or update of level_label, level_value on profile.user_summaries
for each row execute function profile.capture_level_history();
