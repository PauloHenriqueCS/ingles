/**
 * SERVER-ONLY: nunca importar em componentes React ou bundles client-side.
 * Usar apenas em /api/* (Vercel serverless functions).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { CEFRLevel } from '../domain/curriculum/cefr';
import type { LearningSkill } from '../domain/learner/learner-skill-types';
import type {
  PromotionEvidenceBundle,
  MissionEvidence,
  TopicMasteryInfo,
  CheckpointSummary,
  ConsistencyInfo,
} from '../domain/promotion/promotion-types';
import { GRAMMAR_CATALOG } from '../domain/curriculum/grammar-catalog';

// ── Helpers ───────────────────────────────────────────────────────────────────

function toDateString(ts: string | null | undefined): string | null {
  if (!ts) return null;
  return ts.slice(0, 10); // YYYY-MM-DD
}

// ── Writing evidence collection ───────────────────────────────────────────────

async function collectWritingEvidence(
  supabase: SupabaseClient,
  userId: string,
  currentLevel: CEFRLevel,
): Promise<PromotionEvidenceBundle> {
  // 1. Query writing_missions
  const { data: missionRows, error: missionError } = await supabase
    .from('writing_missions')
    .select('id, completed_at, accepted_at')
    .eq('user_id', userId)
    .eq('skill', 'writing')
    .in('status', ['accepted', 'started', 'completed'])
    .neq('mode', 'diagnostic');

  if (missionError) throw new Error(`collectWritingEvidence missions: ${missionError.message}`);

  const missions_data = missionRows ?? [];
  const missionIds = missions_data.map((r: Record<string, unknown>) => String(r.id));
  const dates = missions_data
    .map((r: Record<string, unknown>) => toDateString(String(r.completed_at ?? r.accepted_at ?? '')))
    .filter((d): d is string => d != null && d.length === 10);
  const distinctDates = new Set(dates).size;
  const sortedDates = dates.sort();
  const latestMissionAt = sortedDates.length > 0 ? (sortedDates[sortedDates.length - 1] ?? null) : null;

  const missions: MissionEvidence = {
    validCount: missions_data.length,
    missionIds,
    distinctDates,
    latestMissionAt,
  };

  // 2. Get essential topic IDs for this level from GRAMMAR_CATALOG
  const essentialTopicsFromCatalog = GRAMMAR_CATALOG.filter(
    t => t.expectedMasteryLevel === currentLevel && t.isActive,
  );
  const essentialTopicIds = new Set(essentialTopicsFromCatalog.map(t => t.id));
  const prerequisiteMap = new Map<string, readonly string[]>(
    essentialTopicsFromCatalog.map(t => [t.id, t.prerequisites]),
  );

  // 3. Query learner_grammar_mastery for these topics
  const { data: masteryRows, error: masteryError } = await supabase
    .from('learner_grammar_mastery')
    .select(
      'grammar_topic_id, mastery_state, successful_uses, total_opportunities, confidence, distinct_context_count, last_practiced_at',
    )
    .eq('user_id', userId);

  if (masteryError) throw new Error(`collectWritingEvidence mastery: ${masteryError.message}`);

  const masteryByTopic = new Map<string, Record<string, unknown>>();
  for (const row of masteryRows ?? []) {
    masteryByTopic.set(String(row.grammar_topic_id), row as Record<string, unknown>);
  }

  // 4. Build TopicMasteryInfo for all essential topics
  const masteredTopicIds = new Set<string>();
  for (const [tid, row] of masteryByTopic.entries()) {
    const state = String(row.mastery_state);
    if (state === 'mastered' || state === 'maintenance') {
      masteredTopicIds.add(tid);
    }
  }

  const topicMastery: TopicMasteryInfo[] = [];
  for (const topic of essentialTopicsFromCatalog) {
    const row = masteryByTopic.get(topic.id);
    const mastered = masteredTopicIds.has(topic.id);
    const prerequisites = [...(prerequisiteMap.get(topic.id) ?? [])];
    const prerequisitesMastered = prerequisites.every(p => masteredTopicIds.has(p));

    topicMastery.push({
      topicId: topic.id,
      isEssential: true,
      mastered,
      prerequisites,
      prerequisitesMastered,
      successfulUses: row ? Number(row.successful_uses ?? 0) : 0,
      totalOpportunities: row ? Number(row.total_opportunities ?? 0) : 0,
      confidence: row ? Number(row.confidence ?? 0) : 0,
      distinctContextCount: row ? Number(row.distinct_context_count ?? 0) : 0,
      lastPracticedAt: row ? (row.last_practiced_at != null ? String(row.last_practiced_at) : null) : null,
    });
  }

  // Also include non-essential topics (for completeness, isEssential=false)
  // Only add those NOT already in essential
  for (const [tid, row] of masteryByTopic.entries()) {
    if (!essentialTopicIds.has(tid)) {
      const mastered = masteredTopicIds.has(tid);
      topicMastery.push({
        topicId: tid,
        isEssential: false,
        mastered,
        prerequisites: [],
        prerequisitesMastered: true,
        successfulUses: Number(row.successful_uses ?? 0),
        totalOpportunities: Number(row.total_opportunities ?? 0),
        confidence: Number(row.confidence ?? 0),
        distinctContextCount: Number(row.distinct_context_count ?? 0),
        lastPracticedAt: row.last_practiced_at != null ? String(row.last_practiced_at) : null,
      });
    }
  }

  // 5. Query checkpoints
  const checkpoints = await collectCheckpoints(supabase, userId, 'writing', currentLevel);

  // 6. Build consistency info
  const recentMissionsCount = missions_data.filter((r: Record<string, unknown>) => {
    const at = r.completed_at ?? r.accepted_at;
    if (!at) return false;
    const d = new Date(String(at));
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 30);
    return d >= cutoff;
  }).length;

  const consistency: ConsistencyInfo = {
    distinctDates,
    singleSessionOnly: distinctDates <= 1,
    recentMissionsCount,
    hasDecline: false, // not implemented yet
  };

  return {
    userId,
    skill: 'writing',
    currentLevel,
    missions,
    topicMastery,
    checkpoints,
    consistency,
  };
}

// ── Pronunciation evidence collection ─────────────────────────────────────────

async function collectPronunciationEvidence(
  supabase: SupabaseClient,
  userId: string,
  currentLevel: CEFRLevel,
): Promise<PromotionEvidenceBundle> {
  const { data: assessmentRows, error } = await supabase
    .from('pronunciation_assessments')
    .select('id, accuracy_score, created_at')
    .eq('user_id', userId)
    .eq('status', 'completed');

  if (error) throw new Error(`collectPronunciationEvidence: ${error.message}`);

  const rows = assessmentRows ?? [];
  const dates = rows
    .map((r: Record<string, unknown>) => toDateString(String(r.created_at ?? '')))
    .filter((d): d is string => d != null && d.length === 10);
  const distinctDates = new Set(dates).size;
  const sortedPronDates = dates.sort();
  const latestAt = sortedPronDates.length > 0 ? (sortedPronDates[sortedPronDates.length - 1] ?? null) : null;

  // Average accuracy_score (stored 0-100, convert to 0-1)
  const scores = rows
    .map((r: Record<string, unknown>) => Number(r.accuracy_score))
    .filter(s => !isNaN(s));
  const pronunciationAccuracy =
    scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length / 100 : null;

  const missions: MissionEvidence = {
    validCount: rows.length,
    missionIds: rows.map((r: Record<string, unknown>) => String(r.id)),
    distinctDates,
    latestMissionAt: latestAt,
  };

  const checkpoints = await collectCheckpoints(supabase, userId, 'pronunciation', currentLevel);

  const consistency: ConsistencyInfo = {
    distinctDates,
    singleSessionOnly: distinctDates <= 1,
    recentMissionsCount: rows.length,
    hasDecline: false,
  };

  return {
    userId,
    skill: 'pronunciation',
    currentLevel,
    missions,
    topicMastery: [],
    checkpoints,
    consistency,
    pronunciationAccuracy,
  };
}

// ── Conversation evidence collection ──────────────────────────────────────────

async function collectConversationEvidence(
  supabase: SupabaseClient,
  userId: string,
  currentLevel: CEFRLevel,
): Promise<PromotionEvidenceBundle> {
  const { data: sessionRows, error } = await supabase
    .from('conversation_sessions')
    .select('id, session_date, created_at')
    .eq('user_id', userId)
    .gte('duration_sec', 60);

  if (error) throw new Error(`collectConversationEvidence: ${error.message}`);

  const rows = sessionRows ?? [];
  const dates = rows
    .map((r: Record<string, unknown>) => {
      const d = r.session_date ?? r.created_at;
      return toDateString(d != null ? String(d) : null);
    })
    .filter((d): d is string => d != null && d.length === 10);
  const distinctDates = new Set(dates).size;
  const sortedConvDates = dates.sort();
  const latestAt = sortedConvDates.length > 0 ? (sortedConvDates[sortedConvDates.length - 1] ?? null) : null;

  const conversationSessionCount = rows.length;
  const conversationDistinctContexts = distinctDates; // proxy

  const missions: MissionEvidence = {
    validCount: conversationSessionCount,
    missionIds: rows.map((r: Record<string, unknown>) => String(r.id)),
    distinctDates,
    latestMissionAt: latestAt,
  };

  const checkpoints = await collectCheckpoints(supabase, userId, 'conversation', currentLevel);

  const consistency: ConsistencyInfo = {
    distinctDates,
    singleSessionOnly: distinctDates <= 1,
    recentMissionsCount: rows.length,
    hasDecline: false,
  };

  return {
    userId,
    skill: 'conversation',
    currentLevel,
    missions,
    topicMastery: [],
    checkpoints,
    consistency,
    conversationSessionCount,
    conversationDistinctContexts,
  };
}

// ── Checkpoint collection ─────────────────────────────────────────────────────

async function collectCheckpoints(
  supabase: SupabaseClient,
  userId: string,
  skill: LearningSkill,
  level: CEFRLevel,
): Promise<CheckpointSummary> {
  const { data, error } = await supabase
    .from('promotion_checkpoints')
    .select('passed')
    .eq('user_id', userId)
    .eq('skill', skill)
    .eq('level', level);

  if (error) throw new Error(`collectCheckpoints: ${error.message}`);

  const rows = data ?? [];
  return {
    completedCount: rows.length,
    passedCount: rows.filter((r: Record<string, unknown>) => r.passed === true).length,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function collectSkillEvidence(
  supabase: SupabaseClient,
  userId: string,
  skill: 'writing' | 'pronunciation' | 'conversation',
  currentLevel: CEFRLevel,
): Promise<PromotionEvidenceBundle> {
  switch (skill) {
    case 'writing':
      return collectWritingEvidence(supabase, userId, currentLevel);
    case 'pronunciation':
      return collectPronunciationEvidence(supabase, userId, currentLevel);
    case 'conversation':
      return collectConversationEvidence(supabase, userId, currentLevel);
  }
}
