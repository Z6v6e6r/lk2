-- Preserve the court label received from the legacy game source. Court IDs are
-- integration mappings and cannot be rendered to a user without this local read field.
alter table games.games
  add column court_name text check (court_name is null or char_length(btrim(court_name)) between 1 and 120);
