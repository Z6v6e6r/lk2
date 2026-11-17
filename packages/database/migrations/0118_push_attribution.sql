-- phub:reviewed-blocking-index
set local lock_timeout = '3s';
set local statement_timeout = '30s';

-- Expand-only attribution for web-push installations. The public opt-in page receives a bounded
-- source/community marker from the referring community; segmentation must not depend on UA or logs.

alter table integration.notification_endpoints
  add column if not exists attribution_source text,
  add column if not exists attribution_community text;

alter table integration.notification_endpoints
  drop constraint if exists notification_endpoints_attribution_source_check,
  drop constraint if exists notification_endpoints_attribution_community_check;

alter table integration.notification_endpoints
  add constraint notification_endpoints_attribution_source_check
    check (
      attribution_source is null
      or (char_length(attribution_source) between 1 and 80
          and attribution_source ~ '^[a-z0-9][a-z0-9._-]*$')
    ),
  add constraint notification_endpoints_attribution_community_check
    check (
      attribution_community is null
      or (char_length(attribution_community) between 1 and 200
          and attribution_community !~ '[[:cntrl:]]')
    );

create index if not exists notification_endpoints_attribution_source_idx
  on integration.notification_endpoints (tenant_id, attribution_source, updated_at desc)
  where attribution_source is not null;

create index if not exists notification_endpoints_attribution_community_idx
  on integration.notification_endpoints (tenant_id, attribution_community, updated_at desc)
  where attribution_community is not null;
