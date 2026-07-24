with latest_submission as (
  select distinct on (tenant_id, game_id)
         tenant_id,
         game_id,
         submitted_by_user_id,
         submitted_at
    from games.result_submissions
   order by tenant_id, game_id, revision desc, id desc
)
update games.card_projections projection
   set base_payload = jsonb_set(
         jsonb_set(
           projection.base_payload,
           '{result,submittedByUserId}',
           to_jsonb(latest.submitted_by_user_id),
           true
         ),
         '{result,submittedAt}',
         to_jsonb(latest.submitted_at),
         true
       ),
       projected_at = now()
  from latest_submission latest
 where projection.tenant_id = latest.tenant_id
   and projection.game_id = latest.game_id
   and jsonb_typeof(projection.base_payload -> 'result') = 'object';
