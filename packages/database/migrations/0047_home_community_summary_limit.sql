-- Expand the bounded Home community source from five summaries to ten.
-- Install and validate the wider constraint before dropping the original limit.

alter table integration.community_home_source_components
  add constraint community_home_source_components_payload_limit_10_check
  check (
    jsonb_typeof(payload) = 'array'
    and jsonb_array_length(payload) <= 10
  ) not valid;

alter table integration.community_home_source_components
  validate constraint community_home_source_components_payload_limit_10_check;

alter table integration.community_home_source_components
  drop constraint community_home_source_components_payload_check;
