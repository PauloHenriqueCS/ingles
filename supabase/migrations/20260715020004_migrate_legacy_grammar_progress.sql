-- Conservative migration of any existing learner_grammar_mastery records that have non-zero
-- counters but no canonical evidence. Mark them as provisional with low confidence.
-- Safe to re-run (idempotent: only updates rows with no evidence in learner_grammar_evidence).

UPDATE learner_grammar_mastery lgm
SET
  confidence    = LEAST(lgm.confidence, 0.35),  -- cap at legacy confidence
  rules_version = 'legacy',
  updated_at    = now()
WHERE
  -- Has some recorded activity
  (lgm.total_opportunities > 0 OR lgm.successful_uses > 0)
  -- But no canonical evidence yet
  AND NOT EXISTS (
    SELECT 1 FROM learner_grammar_evidence lge
    WHERE lge.user_id          = lgm.user_id
      AND lge.grammar_topic_id = lgm.grammar_topic_id
  )
  -- Don't touch records that are already marked as legacy
  AND lgm.rules_version != 'legacy';

-- Insert synthetic evidence for legacy mastered records to prevent mastered from being
-- reset by the rebuild engine (LEGACY_MIGRATION source, low weight, low confidence)
INSERT INTO learner_grammar_evidence (
  user_id, grammar_topic_id, catalog_version, skill, source_type, source_id,
  evidence_type, production_mode, outcome,
  opportunity_weight, evidence_weight, confidence,
  planned_topic, topic_role, context_key, context_family, support_level, help_used,
  occurred_at, idempotency_key, rules_version
)
SELECT
  lgm.user_id,
  lgm.grammar_topic_id,
  lgm.catalog_version,
  'writing',
  'manual_admin',
  'legacy_migration',
  'successful_use',
  'unknown',
  'success',
  0.5,   -- moderate opportunity weight
  0.30,  -- low evidence weight (conservative)
  0.35,  -- low confidence (legacy migration)
  false,
  'unplanned',
  'legacy:migration',
  'unknown',
  'medium',
  false,
  lgm.created_at,
  'legacy:' || lgm.user_id || ':' || lgm.grammar_topic_id,
  'legacy'
FROM learner_grammar_mastery lgm
WHERE
  lgm.mastery_state IN ('mastered', 'maintenance', 'consolidating')
  AND NOT EXISTS (
    SELECT 1 FROM learner_grammar_evidence lge
    WHERE lge.user_id = lgm.user_id
      AND lge.grammar_topic_id = lgm.grammar_topic_id
  )
ON CONFLICT (idempotency_key) DO NOTHING;
