-- Keep HTTPS mandatory for promotion media in normal environments while allowing
-- the explicitly configured local/Nano Docker sources supported by the worker.
-- Production configuration rejects PROMOTION_IMAGE_PRIVATE_HTTP_HOSTS entirely.

alter table integration.promotion_media_sync
  drop constraint if exists promotion_media_sync_source_url_check;

alter table integration.promotion_media_sync
  add constraint promotion_media_sync_source_url_check check (
    source_url ~ '^https://'
    or source_url ~ '^http://(localhost|127\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}|host\.docker\.internal|phab-showcase)(:[0-9]{1,5})?(/|$)'
  );
