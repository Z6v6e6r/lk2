/** Canonical score eligibility for the existing i=intent / t=template dispatch queries. */
export const GAME_RESULT_PUSH_ELIGIBILITY_SQL = `case when t.category = 'GAME_RESULT' then exists (
           select 1 from games.games g
           where g.tenant_id=i.tenant_id and g.id::text=i.render_data->>'gameId'
             and g.lifecycle_state='FINISHED'
             and g.ends_at + interval '12 hours' > clock_timestamp()
             and exists (select 1 from games.participations gp where gp.tenant_id=g.tenant_id
               and gp.game_id=g.id and gp.user_id=i.recipient_user_id and gp.state='ACTIVE')
             and ((i.render_data->>'gameResultNotificationType'='game.finished.v1'
               and g.result_state='AWAITING_SUBMISSION')
              or (i.render_data->>'gameResultNotificationType'='game.result.submitted.v1'
               and g.result_state='PENDING_CONFIRMATION'
               and exists (select 1 from games.result_submissions s where s.tenant_id=g.tenant_id
                 and s.game_id=g.id and s.id::text=i.render_data->>'submissionId'
                 and s.state='PENDING_CONFIRMATION')))
         ) else true end`;
