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
