-- The runtime role may also own tables in small installations. FORCE prevents
-- table-owner bypass and keeps tenant context mandatory in every environment.
alter table integration.external_entity_map force row level security;
alter table integration.domain_ownership force row level security;
alter table audit.outbox_events force row level security;
alter table audit.inbox_events force row level security;
alter table audit.audit_log force row level security;
