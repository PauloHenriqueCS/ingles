/**
 * Test user factories and data fixtures.
 *
 * Centralizes test data creation so individual tests stay focused on behavior
 * and don't repeat large setup blocks.
 */
import { Page } from '@playwright/test';
import {
  setupFakeAuth,
  TEST_USER_A,
  TEST_USER_B,
  FAKE_AI_REVIEW,
  SUPABASE_URL,
} from './auth';

// ── User profiles ─────────────────────────────────────────────────────────────

export type UserProfile =
  | 'new_user'
  | 'a1_user'
  | 'a2_user'
  | 'b1_user'
  | 'a1_near_promotion'
  | 'legacy_user'
  | 'user_with_writing'
  | 'user_with_pronunciation'
  | 'user_with_conversation';

export interface TestUserConfig {
  profile: UserProfile;
  user?: typeof TEST_USER_A;
}

// ── Skill level fixtures ──────────────────────────────────────────────────────

export const SKILL_PROFILE_A1 = {
  skill: 'writing',
  cefr_level: 'A1',
  assessment_status: 'confirmed',
  confidence: 0.75,
  assessed_at: new Date().toISOString(),
};

export const SKILL_PROFILE_A2 = {
  skill: 'writing',
  cefr_level: 'A2',
  assessment_status: 'confirmed',
  confidence: 0.85,
  assessed_at: new Date().toISOString(),
};

export const PROMOTION_EVAL_A1_TO_A2 = {
  skill: 'writing',
  current_level: 'A1',
  target_level: 'A2',
  decision: 'keep_level',
  eligible: false,
  confidence: 0.60,
  progress_percent: 45,
  blocking_reasons_json: ['Missões insuficientes (4 de 8)', 'Confiança abaixo de 80%'],
  evaluated_at: new Date().toISOString(),
};

export const PROMOTION_EVAL_NEAR_A2 = {
  skill: 'writing',
  current_level: 'A1',
  target_level: 'A2',
  decision: 'keep_level',
  eligible: false,
  confidence: 0.78,
  progress_percent: 82,
  blocking_reasons_json: ['Confiança abaixo de 80%'],
  evaluated_at: new Date().toISOString(),
};

// ── Mock helpers ──────────────────────────────────────────────────────────────

/**
 * Mocks Supabase REST calls needed by the Dashboard component:
 * - learner_skill_profiles
 * - promotion_evaluations
 * - conversation_sessions
 * - ai_conversation_preferences
 * - english_learning_memory
 * - writing_entries
 */
export async function mockDashboardData(
  page: Page,
  opts: {
    skillProfiles?: unknown[];
    promotionEvals?: unknown[];
    writingEntries?: unknown[];
    convTotalSec?: number;
    convGoalMin?: number;
    hasLearningMemory?: boolean;
  } = {},
) {
  const {
    skillProfiles = [],
    promotionEvals = [],
    writingEntries = [],
    convTotalSec = 0,
    convGoalMin = 15,
    hasLearningMemory = false,
  } = opts;

  if (!SUPABASE_URL) return;

  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' })
    .format(new Date());

  // skill profiles
  await page.route(`${SUPABASE_URL}/rest/v1/learner_skill_profiles*`, (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(skillProfiles),
    });
  });

  // promotion evaluations
  await page.route(`${SUPABASE_URL}/rest/v1/promotion_evaluations*`, (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(promotionEvals),
    });
  });

  // conversation sessions
  await page.route(`${SUPABASE_URL}/rest/v1/conversation_sessions*`, (route) => {
    const sessions = convTotalSec > 0
      ? [{ session_date: today, duration_sec: convTotalSec }]
      : [];
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(sessions),
    });
  });

  // conversation goal
  await page.route(`${SUPABASE_URL}/rest/v1/ai_conversation_preferences*`, (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ daily_conversation_goal_minutes: convGoalMin }]),
    });
  });

  // learning memory
  await page.route(`${SUPABASE_URL}/rest/v1/english_learning_memory*`, (route) => {
    const body = hasLearningMemory
      ? [{ recommended_next_focus: 'Foco em gramática básica', current_level: 'A1' }]
      : [];
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });

  // writing entries
  await page.route(`${SUPABASE_URL}/rest/v1/writing_entries*`, (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(writingEntries),
    });
  });

  // catch-all for other REST calls
  await page.route(`${SUPABASE_URL}/rest/v1/*`, (route) => {
    const url = route.request().url();
    if (
      url.includes('learner_skill_profiles') ||
      url.includes('promotion_evaluations') ||
      url.includes('conversation_sessions') ||
      url.includes('ai_conversation_preferences') ||
      url.includes('english_learning_memory') ||
      url.includes('writing_entries')
    ) {
      route.continue();
    } else {
      route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    }
  });
}

/**
 * Mocks all REST calls needed by the calendar (MonthView).
 */
export async function mockCalendarData(
  page: Page,
  opts: {
    pronunciationDates?: string[];
    convTotals?: Record<string, number>;
    convGoalMin?: number;
  } = {},
) {
  const { pronunciationDates = [], convTotals = {}, convGoalMin = 15 } = opts;

  if (!SUPABASE_URL) return;

  // pronunciation assessments for the month
  await page.route(`${SUPABASE_URL}/rest/v1/pronunciation_assessments*`, (route) => {
    const rows = pronunciationDates.map((d) => ({
      completed_at: `${d}T12:00:00Z`,
    }));
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(rows),
    });
  });

  // conversation sessions
  await page.route(`${SUPABASE_URL}/rest/v1/conversation_sessions*`, (route) => {
    const sessions = Object.entries(convTotals).map(([date, sec]) => ({
      session_date: date,
      duration_sec: sec,
    }));
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(sessions),
    });
  });

  // conversation goal
  await page.route(`${SUPABASE_URL}/rest/v1/ai_conversation_preferences*`, (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ daily_conversation_goal_minutes: convGoalMin }]),
    });
  });

  // settings and overrides
  await page.route(`${SUPABASE_URL}/rest/v1/user_learning_settings*`, (route) => {
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
  await page.route(`${SUPABASE_URL}/rest/v1/learning_day_overrides*`, (route) => {
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });

  // catch-all
  await page.route(`${SUPABASE_URL}/rest/v1/*`, (route) => {
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
}

/**
 * Sets up a complete mocked environment for a new user (no history).
 */
export async function setupNewUser(page: Page) {
  await setupFakeAuth(page, TEST_USER_A);
  await mockDashboardData(page, {
    skillProfiles: [],
    promotionEvals: [],
    writingEntries: [],
    convTotalSec: 0,
  });
}

/**
 * Sets up a mocked environment for a user with A1 writing level.
 */
export async function setupA1User(page: Page) {
  await setupFakeAuth(page, TEST_USER_A);
  await mockDashboardData(page, {
    skillProfiles: [SKILL_PROFILE_A1],
    promotionEvals: [PROMOTION_EVAL_A1_TO_A2],
    writingEntries: [],
    convTotalSec: 0,
  });
}

/**
 * Sets up a mocked environment for a user near promotion to A2.
 */
export async function setupA1NearPromotion(page: Page) {
  await setupFakeAuth(page, TEST_USER_A);
  await mockDashboardData(page, {
    skillProfiles: [SKILL_PROFILE_A1],
    promotionEvals: [PROMOTION_EVAL_NEAR_A2],
    writingEntries: [],
    convTotalSec: 0,
  });
}

/**
 * Sets up a mocked environment for a user with a completed writing entry.
 */
export async function setupUserWithWriting(page: Page) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' })
    .format(new Date());

  await setupFakeAuth(page, TEST_USER_A);

  const entry = {
    entry_date: today,
    user_id: TEST_USER_A.id,
    month: parseInt(today.slice(5, 7), 10),
    year: parseInt(today.slice(0, 4), 10),
    theme: 'Test theme',
    title: 'My writing test',
    original_text: 'I love learning English every single day.',
    corrected_text: 'I love learning English every single day.',
    status: 'revisado',
    word_count: 8,
    updated_at: new Date().toISOString(),
    reviewed_at: new Date().toISOString(),
    ai_score: 82,
    cefr_level: 'A2',
    grammar_score: 80,
    vocabulary_score: 84,
    naturalness_score: 82,
    fluency_score: 80,
    ai_summary: 'Good job!',
    ai_main_errors: [],
    new_vocabulary: [],
    difficulty: null,
    objective: null,
  };

  await mockDashboardData(page, {
    skillProfiles: [SKILL_PROFILE_A2],
    promotionEvals: [],
    writingEntries: [entry],
    convTotalSec: 0,
  });

  // Also inject into localStorage
  await page.addInitScript(
    ({ key, date, e }: { key: string; date: string; e: unknown }) => {
      const stored = JSON.parse(localStorage.getItem(key) ?? '{}');
      stored[date] = e;
      localStorage.setItem(key, JSON.stringify(stored));
    },
    {
      key: `english-calendar-entries-v2-${TEST_USER_A.id}`,
      date: today,
      e: {
        date: today,
        title: 'My writing test',
        originalText: 'I love learning English every single day.',
        correctedText: 'I love learning English every single day.',
        observations: '',
        mainErrors: '',
        difficulty: null,
        status: 'revisado',
        wordCount: 8,
        updatedAt: new Date().toISOString(),
        reviewedAt: new Date().toISOString(),
        aiReview: FAKE_AI_REVIEW,
      },
    },
  );
}
