-- ============================================================================
-- Admin: hard delete of a user's PERSONAL data (destructive, idempotent).
-- ----------------------------------------------------------------------------
-- This RPC removes everything the user personally owns in the public schema, in
-- child→parent FK order, and returns a per-table count of what it deleted. It
-- deliberately does NOT:
--   * delete the auth.users row — that is done by the API layer via the GoTrue
--     Admin API (auth.admin.deleteUser), the appropriate server-side operation.
--     After this RPC clears the RESTRICT/NO-ACTION blockers, that call cascades
--     the remaining CASCADE tables and SET NULLs the anonymized-usage tables.
--   * touch Supabase Storage — the API removes listening-audio/story-sessions/
--     <userId>/ objects (SQL cannot delete physical storage objects).
--   * delete SHARED/GLOBAL cached content — only the user's link rows
--     (user_shared_content_usage, user_listening_shared_progress) are removed;
--     shared_content_items / listening_shared_stories and their audio stay.
--
-- Retention decisions (confirmed with the product owner):
--   * KEEP  public.user_communication_blocks  — destination_hash suppression
--     (LGPD): survives via its ON DELETE SET NULL FK when the auth user goes.
--   * KEEP  public.revenuecat_webhook_events  — financial/idempotency log.
--   * KEEP  the ON DELETE SET NULL analytics rows (usage_daily, ai_usage_events,
--     ai_provider_sessions, ai_gateway_decisions, usage_reservations,
--     engine_activation_log) — anonymized (user_id nulled) automatically.
--   * DELETE public.user_billing_blocks and public.user_account_deactivations —
--     they are user_id-scoped and become inert once the UUID is gone; deleting
--     them lets the auth user be removed without altering app-owned constraints.
--
-- Safety: refuses to run against an admin account, and requires the actor to be
-- an active owner (defense in depth on top of the API's requireAdminPermission).
-- ============================================================================

create or replace function public.admin_hard_delete_user_v1(
  p_user_id  uuid,
  p_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  -- child → parent order. Every table here is PERSONAL (deleting a row never
  -- removes shared/global content). Non-standard user columns are noted.
  v_targets text[][] := array[
    -- listening (per-user)
    ['user_listening_attempts','user_id'],
    ['user_listening_block_sessions','user_id'],
    ['user_listening_results','user_id'],
    ['user_listening_generation_sessions','user_id'],
    ['user_listening_progress','user_id'],
    ['user_listening_assignments','user_id'],
    ['user_listening_shared_progress','user_id'],
    -- review ("revisar meus erros")
    ['review_item_attempts','user_id'],
    ['review_attempts','user_id'],
    ['review_group_items','user_id'],
    ['review_groups','user_id'],
    ['review_schedule_history','user_id'],
    -- writing (delete referrers of english_reviews before it)
    ['writing_rewrite_evidence_candidates','user_id'],
    ['writing_rewrite_evaluations','user_id'],
    ['writing_rewrite_attempts','user_id'],
    ['writing_review_reservations','user_id'],
    ['writing_entries','user_id'],
    ['generated_themes','user_id'],
    -- pronunciation
    ['pronunciation_word_attempts','user_id'],
    ['pronunciation_assessments','user_id'],
    ['pronunciation_training_sessions','user_id'],
    -- conversation
    ['conversation_session_authorizations','user_id'],
    ['conversation_sessions','user_id'],
    ['user_conversation_credits','user_id'],
    -- writing core (parents; children above already gone / cascade)
    ['english_reviews','user_id'],
    ['english_learning_memory','user_id'],
    -- placement (children cascade off attempt_id)
    ['placement_attempts','user_id'],
    -- curriculum / progress / preferences
    ['user_subtopic_completion','user_id'],
    ['user_subtopic_modality_progress','user_id'],
    ['user_curriculum_progress','user_id'],
    ['user_curriculum_preferences','user_id'],
    ['user_learning_paths','user_id'],
    ['learner_skill_profiles','user_id'],
    -- settings / calendar
    ['learning_day_overrides','user_id'],
    ['user_learning_settings','user_id'],
    ['ai_conversation_preferences','user_id'],
    -- per-user AI scoping
    ['ai_gateway_quota_buckets','subject_id'],
    -- entitlements / plan / access
    ['user_capability_overrides','user_id'],
    ['user_plan_assignments','user_id'],
    ['user_access_controls','user_id'],
    -- shared-content link (shared item itself is preserved)
    ['user_shared_content_usage','user_id'],
    -- user-id-scoped blocks (deleted per retention decision)
    ['user_billing_blocks','user_id'],
    ['user_account_deactivations','user_id']
  ];
  v_table text;
  v_col   text;
  v_count bigint;
  v_total bigint := 0;
  v_counts jsonb := '{}'::jsonb;
  v_actor_role text;
begin
  if p_user_id is null then
    raise exception 'HARD_DELETE_INVALID_USER: user_id is null' using errcode = '22004';
  end if;

  -- Actor must be an active owner (belt-and-suspenders over the API gate).
  select role into v_actor_role
  from public.admin_users
  where user_id = p_actor_id and status = 'active';
  if v_actor_role is null or v_actor_role <> 'owner' then
    raise exception 'HARD_DELETE_FORBIDDEN: actor is not an active owner' using errcode = '42501';
  end if;

  -- Never hard-delete an admin account through this tool (also avoids the
  -- NO ACTION staff-column FKs that would block the auth deletion downstream).
  if exists (select 1 from public.admin_users where user_id = p_user_id) then
    raise exception 'HARD_DELETE_ADMIN_ACCOUNT: refusing to hard-delete an admin account' using errcode = '42501';
  end if;

  -- Delete each target table by its user column, tolerating tables that may not
  -- exist in a given environment (homolog drift): guard with to_regclass.
  for i in 1 .. array_length(v_targets, 1) loop
    v_table := v_targets[i][1];
    v_col   := v_targets[i][2];
    if to_regclass('public.' || v_table) is null then
      continue;
    end if;
    execute format('delete from public.%I where %I = $1', v_table, v_col) using p_user_id;
    get diagnostics v_count = row_count;
    if v_count > 0 then
      v_counts := v_counts || jsonb_build_object(v_table, v_count);
      v_total := v_total + v_count;
    end if;
  end loop;

  return jsonb_build_object(
    'user_id', p_user_id,
    'total_rows_deleted', v_total,
    'deleted_counts', v_counts,
    'auth_user_deleted', false,   -- the API performs auth.admin.deleteUser afterwards
    'executed_at', now()
  );
end;
$$;

grant execute on function public.admin_hard_delete_user_v1(uuid, uuid) to service_role;
