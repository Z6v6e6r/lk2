-- Expand the LOCAL_ONLY privacy aggregate with owner-selected profile visibility.
-- The API still evaluates these settings server-side before serializing another
-- player's profile; clients never receive fields hidden by the owner policy.

alter table profile.privacy_settings
  add column visibility_mode text not null default 'OPEN',
  add column section_visibility jsonb not null default '{
    "avatar": true,
    "levelAndRating": true,
    "gameHistory": true,
    "levelHistory": false,
    "favoriteClubs": true,
    "friends": false,
    "telegram": false,
    "achievements": true,
    "communities": false
  }'::jsonb;

update profile.privacy_commands
   set result_payload = result_payload
     || jsonb_build_object(
       'visibilityMode', 'OPEN',
       'sections', '{
         "avatar": true,
         "levelAndRating": true,
         "gameHistory": true,
         "levelHistory": false,
         "favoriteClubs": true,
         "friends": false,
         "telegram": false,
         "achievements": true,
         "communities": false
       }'::jsonb
     )
 where not (result_payload ? 'visibilityMode')
    or not (result_payload ? 'sections');

alter table profile.privacy_settings
  add constraint privacy_settings_visibility_mode_check
    check (visibility_mode in ('OPEN', 'LIMITED', 'PRIVATE')) not valid,
  add constraint privacy_settings_section_visibility_check
    check (
      jsonb_typeof(section_visibility) = 'object'
      and jsonb_typeof(section_visibility -> 'avatar') = 'boolean'
      and jsonb_typeof(section_visibility -> 'levelAndRating') = 'boolean'
      and jsonb_typeof(section_visibility -> 'gameHistory') = 'boolean'
      and jsonb_typeof(section_visibility -> 'levelHistory') = 'boolean'
      and jsonb_typeof(section_visibility -> 'favoriteClubs') = 'boolean'
      and jsonb_typeof(section_visibility -> 'friends') = 'boolean'
      and jsonb_typeof(section_visibility -> 'telegram') = 'boolean'
      and jsonb_typeof(section_visibility -> 'achievements') = 'boolean'
      and jsonb_typeof(section_visibility -> 'communities') = 'boolean'
    ) not valid;

alter table profile.privacy_settings
  validate constraint privacy_settings_visibility_mode_check;

alter table profile.privacy_settings
  validate constraint privacy_settings_section_visibility_check;
