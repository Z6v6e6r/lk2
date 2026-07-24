-- Expand-only Games result model. The immutable submission keeps the command snapshot,
-- while confirmed sets and player facts are normalized for deterministic projections.

alter table games.result_submissions
  add column confirmation_quorum smallint not null default 1
    check (confirmation_quorum between 1 and 3);

alter table games.result_submission_reviews
  add column note text check (note is null or char_length(note) between 1 and 500);

create table games.result_sets (
  tenant_id uuid not null,
  game_id uuid not null,
  result_id uuid not null,
  set_number smallint not null check (set_number between 1 and 9),
  team_a_score smallint not null check (team_a_score between 0 and 99),
  team_b_score smallint not null check (team_b_score between 0 and 99),
  primary key (tenant_id, result_id, set_number),
  foreign key (tenant_id, game_id, result_id)
    references games.results(tenant_id, game_id, id),
  check (team_a_score <> team_b_score)
);

create table games.result_set_players (
  tenant_id uuid not null,
  game_id uuid not null,
  result_id uuid not null,
  set_number smallint not null,
  user_id uuid not null,
  team text not null check (team in ('A', 'B')),
  slot smallint not null check (slot in (1, 2)),
  primary key (tenant_id, result_id, set_number, user_id),
  unique (tenant_id, result_id, set_number, team, slot),
  foreign key (tenant_id, result_id, set_number)
    references games.result_sets(tenant_id, result_id, set_number),
  foreign key (tenant_id, game_id) references games.games(tenant_id, id),
  foreign key (tenant_id, user_id) references identity.users(tenant_id, id)
);

-- Immutable, replay-safe analytical projection. It is derived only from a confirmed result.
create table games.player_set_facts (
  tenant_id uuid not null,
  game_id uuid not null,
  result_id uuid not null,
  result_revision integer not null check (result_revision > 0),
  set_number smallint not null,
  user_id uuid not null,
  teammate_user_id uuid not null,
  team text not null check (team in ('A', 'B')),
  score_for smallint not null check (score_for between 0 and 99),
  score_against smallint not null check (score_against between 0 and 99),
  outcome text not null check (outcome in ('WON', 'LOST')),
  occurred_at timestamptz not null,
  projected_at timestamptz not null default now(),
  primary key (tenant_id, result_id, set_number, user_id),
  foreign key (tenant_id, result_id, set_number)
    references games.result_sets(tenant_id, result_id, set_number),
  foreign key (tenant_id, game_id) references games.games(tenant_id, id),
  foreign key (tenant_id, user_id) references identity.users(tenant_id, id),
  foreign key (tenant_id, teammate_user_id) references identity.users(tenant_id, id),
  check (user_id <> teammate_user_id)
);

create index games_player_set_facts_timeline_idx
  on games.player_set_facts (tenant_id, user_id, occurred_at desc, game_id, set_number);

alter table games.result_sets enable row level security;
alter table games.result_set_players enable row level security;
alter table games.player_set_facts enable row level security;

create policy games_result_sets_tenant_isolation on games.result_sets
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

create policy games_result_set_players_tenant_isolation on games.result_set_players
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

create policy games_player_set_facts_tenant_isolation on games.player_set_facts
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table games.result_sets force row level security;
alter table games.result_set_players force row level security;
alter table games.player_set_facts force row level security;
