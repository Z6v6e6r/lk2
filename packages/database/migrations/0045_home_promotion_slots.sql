-- Expand the existing CUP promotion source from one lower placement into two
-- independent slots. Existing payloads remain valid until the worker publishes
-- the new { hero, standard } shape.

alter table integration.promotion_home_source_components
  drop constraint if exists promotion_home_source_components_payload_check;

alter table integration.promotion_home_source_components
  add constraint promotion_home_source_components_payload_check check (
    jsonb_typeof(payload) = 'object'
    and (
      (
        jsonb_typeof(payload -> 'items') = 'array'
        and jsonb_array_length(payload -> 'items') <= 20
      )
      or (
        jsonb_typeof(payload -> 'hero') = 'object'
        and jsonb_typeof(payload -> 'hero' -> 'items') = 'array'
        and jsonb_array_length(payload -> 'hero' -> 'items') <= 20
        and jsonb_typeof(payload -> 'standard') = 'object'
        and jsonb_typeof(payload -> 'standard' -> 'items') = 'array'
        and jsonb_array_length(payload -> 'standard' -> 'items') <= 20
      )
    )
  );
