set local lock_timeout = '5s';
set local statement_timeout = '30s';

create table games.friend_invitations (
  tenant_id uuid not null,
  game_id uuid not null,
  recipient_user_id uuid not null,
  issued_at timestamptz,
  primary key (tenant_id, game_id, recipient_user_id),
  foreign key (tenant_id, game_id) references games.games (tenant_id, id),
  foreign key (tenant_id, recipient_user_id) references identity.users (tenant_id, id)
);

alter table games.friend_invitations enable row level security;
alter table games.friend_invitations force row level security;

create policy game_friend_invitations_tenant on games.friend_invitations
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- The runtime role is provisioned separately. Fresh developer and CI databases
-- may run the migration before creating that role.
revoke all privileges on table games.friend_invitations from public;

do $$
begin
  if pg_catalog.to_regrole('phub_runtime') is not null then
    revoke all privileges on table games.friend_invitations from phub_runtime;
    grant select on table games.friend_invitations to phub_runtime;
    grant insert (tenant_id, game_id, recipient_user_id)
      on table games.friend_invitations to phub_runtime;
    grant update (issued_at) on table games.friend_invitations to phub_runtime;
  end if;
end
$$;
