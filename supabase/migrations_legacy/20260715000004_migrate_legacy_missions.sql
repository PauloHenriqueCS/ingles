-- Data migration: backfill writing_missions from generated_themes.
-- Runs only when CANONICAL_WRITING_MISSION_STATE_V1 is enabled.
-- Legacy themes that have a completed english_review are imported as 'completed';
-- themes with no review are imported as 'generated'.
-- This migration is SAFE to re-run (idempotent via ON CONFLICT DO NOTHING).

INSERT INTO writing_missions (
  id,
  user_id,
  skill,
  status,
  mode,
  title,
  prompt_pt_br,
  level,
  difficulty,
  suggested_words,
  support_sentences,
  legacy_theme_id,
  generated_at,
  accepted_at,
  completed_at
)
SELECT
  gen_random_uuid()           AS id,
  gt.user_id,
  'writing'                   AS skill,
  CASE
    WHEN er.id IS NOT NULL THEN 'completed'::mission_status
    ELSE                        'generated'::mission_status
  END                         AS status,
  'normal'::writing_mission_mode AS mode,
  COALESCE(gt.theme->>'title', gt.theme->>'titulo', 'Missão importada') AS title,
  COALESCE(gt.theme->>'prompt', gt.theme->>'promptPtBR', '') AS prompt_pt_br,
  COALESCE(gt.theme->>'level', 'B1')       AS level,
  COALESCE(gt.theme->>'difficulty', 'medium') AS difficulty,
  NULL                        AS suggested_words,
  NULL                        AS support_sentences,
  gt.id                       AS legacy_theme_id,
  gt.created_at               AS generated_at,
  er.created_at               AS accepted_at,
  er.created_at               AS completed_at
FROM generated_themes gt
LEFT JOIN english_reviews er ON er.theme_id = gt.id
-- Skip themes already imported
WHERE NOT EXISTS (
  SELECT 1 FROM writing_missions wm WHERE wm.legacy_theme_id = gt.id
)
ON CONFLICT DO NOTHING;
