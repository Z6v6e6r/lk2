-- Expand the projection's accepted provenance to canonical CUP match and tournament events.
-- All rows covered by the preceding validated constraint satisfy this wider check.
alter table eligibility.cup_player_level_projections
  drop constraint cup_player_level_projections_source_event_type_check,
  add constraint cup_player_level_projections_source_event_type_check check (
    source_event_type in (
      'RATING_INITIAL_IMPORTED',
      'RATING_BOOTSTRAPPED_FROM_VIVA',
      'RATING_MANUALLY_CHANGED',
      'RATING_BOOTSTRAPPED_FROM_GAME_RESULT',
      'RATING_BOOTSTRAPPED_FROM_TOURNAMENT',
      'RATING_TOURNAMENT_CANONICAL_RECONCILED',
      'RATING_LEVEL_CORRECTION_APPLIED',
      'FPR_CANONICAL_RECONCILIATION_APPLIED',
      'GAME_RESULT_SUBMITTED_APPLIED',
      'GAME_RESULT_CORRECTION_APPLIED',
      'GAME_RESULT_CORRECTION_REVERTED',
      'GAME_RESULT_DISPUTED_REVERTED',
      'GAME_RESULT_EXPIRED_REVERTED',
      'GAME_RESULT_CONFIRMED',
      'GAME_RESULT_TIMEOUT_CONFIRMED',
      'TOURNAMENT_RATING_FINALIZED',
      'TOURNAMENT_RATING_CORRECTION_APPLIED',
      'TOURNAMENT_RATING_REOPENED_REVERTED',
      'TOURNAMENT_RATING_ANNULLED',
      'TOURNAMENT_RATING_CORRECTION_REVERTED',
      'TOURNAMENT_START_RATING_CHANGED'
    )
  ) not valid;
