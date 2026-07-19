-- Expand-only profile summary field used by reusable Games card projections.
-- The value is a coarse PadlHub level label; raw provider ratings remain in integration storage.

alter table profile.user_summaries
  add column level_label text
  check (level_label is null or level_label in ('D', 'D+', 'C', 'C+', 'B', 'B+', 'A'));
