-- Expand-only numeric PadlHub rating used to render progress within the current level.
-- Provider identifiers remain in integration storage; this normalized presentation value does not.

alter table profile.user_summaries
  add column level_value numeric(8, 5)
  check (level_value is null or (level_value >= 0 and level_value <= 10));
