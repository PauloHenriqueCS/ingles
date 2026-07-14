export type MissionTransitionReasonCode =
  | 'user_accepted'
  | 'user_started'
  | 'user_completed'
  | 'user_skipped'
  | 'user_superseded'
  | 'system_expired'
  | 'system_cancelled'
  | 'admin_cancelled';

export type MissionSkipReasonCode =
  | 'too_difficult'
  | 'not_relevant'
  | 'already_know'
  | 'not_interested'
  | 'other';

export type MissionCancellationReasonCode =
  | 'user_request'
  | 'system_expiry'
  | 'superseded_by_new'
  | 'admin_action';

export type MissionTransitionSource =
  | 'user_action'
  | 'system_scheduler'
  | 'admin_action'
  | 'migration';
