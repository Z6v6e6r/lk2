-- Expand/migrate step: profile action access is deliberately independent from
-- subscriptions and memberships. The future access-grant contour may supply
-- permissions, while privacy only decides whether an authorized viewer may act.

alter table profile.privacy_settings
  drop constraint if exists privacy_settings_contact_policy_check;

alter table profile.privacy_settings
  drop constraint if exists privacy_settings_chat_policy_check;

alter table profile.privacy_settings
  alter column contact_policy drop default,
  alter column chat_policy drop default;

update profile.privacy_settings
set contact_policy = 'AUTHORIZED'
where contact_policy = 'SUBSCRIBERS';

update profile.privacy_settings
set chat_policy = 'AUTHORIZED'
where chat_policy = 'SUBSCRIBERS';

update profile.privacy_commands
set result_payload = case
  when result_payload ->> 'contactPolicy' = 'SUBSCRIBERS'
    then jsonb_set(result_payload, '{contactPolicy}', to_jsonb('AUTHORIZED'::text))
  else result_payload
end;

update profile.privacy_commands
set result_payload = case
  when result_payload ->> 'chatPolicy' = 'SUBSCRIBERS'
    then jsonb_set(result_payload, '{chatPolicy}', to_jsonb('AUTHORIZED'::text))
  else result_payload
end;

alter table profile.privacy_settings
  alter column contact_policy set default 'AUTHORIZED',
  alter column chat_policy set default 'AUTHORIZED';

alter table profile.privacy_settings
  add constraint privacy_settings_contact_policy_check
    check (contact_policy in ('AUTHORIZED', 'NOBODY')) not valid;

alter table profile.privacy_settings
  add constraint privacy_settings_chat_policy_check
    check (chat_policy in ('AUTHORIZED', 'NOBODY')) not valid;

alter table profile.privacy_settings
  validate constraint privacy_settings_contact_policy_check;

alter table profile.privacy_settings
  validate constraint privacy_settings_chat_policy_check;
