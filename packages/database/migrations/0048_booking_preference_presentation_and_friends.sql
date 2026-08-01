-- Expand the LOCAL_ONLY recommendation preference aggregate without changing its writer.
-- Defaults preserve the current Home V3 grid and enable the new friend-aware signal.

alter table profile.booking_preferences
  add column recommend_friends boolean not null default true,
  add column recommendation_display text not null default 'CARDS'
    check (recommendation_display in ('CARDS', 'ROWS'));
