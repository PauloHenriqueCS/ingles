/**
 * Helpers for injecting a fake authenticated Supabase session in Playwright tests.
 *
 * Strategy:
 * 1. addInitScript: sets the Supabase session in localStorage BEFORE the app loads
 * 2. page.route: mocks the Supabase auth API so getUser() validates the fake token
 * 3. page.route: mocks Supabase REST calls for english_reviews, settings, etc.
 *
 * This avoids the need for real credentials in mocked UI tests.
 */
import { Page } from '@playwright/test';

export const TEST_USER_A = {
  id:    'eeeeeeee-aaaa-0000-0000-000000000001',
  email: 'user-a@e2e-test.dev',
  token: 'e2e-fake-access-token-user-a',
};

export const TEST_USER_B = {
  id:    'eeeeeeee-bbbb-0000-0000-000000000002',
  email: 'user-b@e2e-test.dev',
  token: 'e2e-fake-access-token-user-b',
};

export const TEST_REVIEW_ID    = 'cccccccc-0000-0000-0000-000000000001';
export const TEST_ASSESSMENT_ID = 'dddddddd-0000-0000-0000-000000000001';
export const TEST_ATTEMPT_ID    = 'ffffffff-0000-0000-0000-000000000001';

export const TEST_REFERENCE_TEXT =
  "Hello, my name is Alex and I'm a software engineer. " +
  "I've been working with computers for over ten years, " +
  "and I absolutely love what I do every single day. " +
  "Programming is not just my profession — it's my passion. " +
  "I enjoy solving complex problems and building useful applications " +
  "that help people around the world do their work more efficiently.";

// Fake AI review data for the test entry
export const FAKE_AI_REVIEW = {
  score:         85,
  level:         'B2',
  grammar:       88,
  vocabulary:    82,
  naturalness:   85,
  fluency:       80,
  summary:       'Good work!',
  correctedText: TEST_REFERENCE_TEXT,
  mainMistakes:  [],
  newVocabulary: [],
  objectiveFeedback: 'Keep it up!',
  nextPractice:  'Practice more.',
};

export const FAKE_RESULT = {
  pronunciationScore:   78,
  accuracyScore:        80,
  fluencyScore:         75,
  completenessScore:    82,
  prosodyScore:         72,
  recognizedText:       'hello my name is Alex',
  wordsJson:            [],
  rawSegments:          [],
  audioDurationSeconds: 3,
};

/**
 * Returns the Supabase project reference extracted from the env URL.
 * e.g. "https://abcdef.supabase.co" → "abcdef"
 */
export function getProjectRef(): string {
  const url = process.env.VITE_SUPABASE_URL ?? 'https://placeholder.supabase.co';
  try {
    return new URL(url).hostname.split('.')[0];
  } catch {
    return 'placeholder';
  }
}

/** The Supabase project URL (needed to build route patterns). */
export const SUPABASE_URL = process.env.VITE_SUPABASE_URL ?? '';

/**
 * Injects a fake Supabase session into localStorage for the given user
 * and mocks the auth/v1/user endpoint.
 *
 * Call BEFORE page.goto().
 */
export async function setupFakeAuth(page: Page, user = TEST_USER_A) {
  const projectRef = getProjectRef();
  const lsKey = `sb-${projectRef}-auth-token`;

  const fakeSession = {
    access_token:  user.token,
    token_type:    'bearer',
    expires_in:    3600,
    expires_at:    Math.floor(Date.now() / 1000) + 3600,
    refresh_token: `${user.token}-refresh`,
    user: {
      id:           user.id,
      aud:          'authenticated',
      email:        user.email,
      role:         'authenticated',
      created_at:   new Date().toISOString(),
      updated_at:   new Date().toISOString(),
      app_metadata: { provider: 'email' },
      user_metadata: {},
    },
  };

  // Inject into localStorage before any scripts run
  await page.addInitScript(
    ({ key, value }: { key: string; value: string }) => {
      localStorage.setItem(key, value);
    },
    { key: lsKey, value: JSON.stringify(fakeSession) },
  );

  // Mock Supabase auth API validation calls
  if (SUPABASE_URL) {
    await page.route(`${SUPABASE_URL}/auth/v1/user*`, (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(fakeSession.user),
      });
    });

    await page.route(`${SUPABASE_URL}/auth/v1/token*`, (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(fakeSession),
      });
    });
  }
}

/**
 * Mocks Supabase REST calls to return an entry with AI review data
 * so DayView shows the PronunciationRecorder.
 */
export async function mockReviewData(
  page: Page,
  opts: {
    status?: 'available' | 'processing' | 'completed' | 'failed_retryable' | 'failed_final';
    result?: typeof FAKE_RESULT | null;
  } = {},
) {
  const { status = 'available', result = null } = opts;

  const today = new Date().toISOString().split('T')[0];
  const userId = TEST_USER_A.id;

  // ── Inject entry into localStorage so the app has AI review data ────────────
  await page.addInitScript(
    ({ key, entry }: { key: string; entry: unknown }) => {
      const existing = JSON.parse(localStorage.getItem(key) ?? '{}');
      existing[new Date().toISOString().split('T')[0]] = entry;
      localStorage.setItem(key, JSON.stringify(existing));
    },
    {
      key: `english-calendar-entries-v2-${userId}`,
      entry: {
        date:          today,
        title:         'E2E Test Entry',
        originalText:  'Hello world this is my test entry for pronunciation training.',
        correctedText: TEST_REFERENCE_TEXT,
        status:        'corrigido',
        difficulty:    null,
        wordCount:     12,
        updatedAt:     new Date().toISOString(),
        reviewedAt:    new Date().toISOString(),
        aiReview:      FAKE_AI_REVIEW,
      },
    },
  );

  // ── Mock Supabase REST: english_reviews → return review with reviewId ────────
  if (SUPABASE_URL) {
    await page.route(`${SUPABASE_URL}/rest/v1/english_reviews*`, (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id:                       TEST_REVIEW_ID,
            user_id:                  userId,
            original_text:            'Hello world',
            corrected_text:           TEST_REFERENCE_TEXT,
            version_2_text:           TEST_REFERENCE_TEXT,
            version_2_comparison:     null,
            version_2_improvement_score: null,
            score:                    85,
            level:                    'B2',
            grammar:                  88,
            vocabulary:               82,
            naturalness:              85,
            fluency:                  80,
            summary:                  'Good work!',
            main_mistakes:            [],
            new_vocabulary:           [],
            objective_feedback:       'Keep it up!',
            next_practice:            'Practice more.',
            category:                 null,
            difficulty:               null,
            objective:                null,
            entry_date:               today,
            created_at:               new Date().toISOString(),
          },
        ]),
      });
    });

    // Mock writing_entries so fetchAllEntries returns the injected entry (not empty)
    await page.route(`${SUPABASE_URL}/rest/v1/writing_entries*`, (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            entry_date:           today,
            user_id:              userId,
            month:                parseInt(today.slice(5, 7), 10),
            year:                 parseInt(today.slice(0, 4), 10),
            theme:                '',
            grammar_goal:         null,
            main_tense:           null,
            title:                'E2E Test Entry',
            original_text:        'Hello world this is my test entry for pronunciation training.',
            corrected_text:       TEST_REFERENCE_TEXT,
            notes:                null,
            main_errors:          null,
            difficulty:           null,
            status:               'corrigido',
            word_count:           12,
            updated_at:           new Date().toISOString(),
            ai_score:             85,
            cefr_level:           'B2',
            grammar_score:        88,
            vocabulary_score:     82,
            naturalness_score:    85,
            fluency_score:        80,
            ai_summary:           'Good work!',
            grammar_feedback:     [],
            ai_main_errors:       [],
            new_vocabulary:       [],
            natural_expressions:  [],
            grammar_goal_achieved: null,
            rewrite_challenge:    'Practice more.',
            reviewed_at:          new Date().toISOString(),
          },
        ]),
      });
    });

    // Mock all other REST calls (settings, overrides, etc.) with safe defaults
    await page.route(`${SUPABASE_URL}/rest/v1/user_learning_settings*`, (route) => {
      route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });
    await page.route(`${SUPABASE_URL}/rest/v1/learning_day_overrides*`, (route) => {
      route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });
    await page.route(`${SUPABASE_URL}/rest/v1/grammar_explanations*`, (route) => {
      route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });
    // Catch-all for other REST calls — let specific mocks handle english_reviews and writing_entries
    await page.route(`${SUPABASE_URL}/rest/v1/*`, (route) => {
      const url = route.request().url();
      if (url.includes('english_reviews') || url.includes('writing_entries')) {
        route.continue(); // pass to the specific handler registered earlier
      } else {
        route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
      }
    });
  }

  // ── Mock pronunciation status ────────────────────────────────────────────────
  const statusResponse =
    status === 'completed' && result
      ? { status: 'completed', canAnalyze: false, assessmentId: TEST_ASSESSMENT_ID, result }
      : status === 'processing'
      ? { status: 'processing', canAnalyze: false, assessmentId: TEST_ASSESSMENT_ID }
      : status === 'failed_retryable'
      ? { status: 'failed_retryable', canAnalyze: true, assessmentId: TEST_ASSESSMENT_ID }
      : status === 'failed_final'
      ? { status: 'failed_final', canAnalyze: true, assessmentId: TEST_ASSESSMENT_ID }
      : { status: 'available', canAnalyze: true, assessmentId: null };

  await page.route('/api/pronunciation/status*', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Cache-Control': 'no-store' },
      body: JSON.stringify(statusResponse),
    });
  });
}

/**
 * Mocks /api/pronunciation/start to return test credentials.
 * Does NOT issue a real Azure token.
 */
export async function mockPronunciationStart(page: Page) {
  await page.route('/api/pronunciation/start', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Cache-Control': 'no-store' },
      body: JSON.stringify({
        assessmentId:  TEST_ASSESSMENT_ID,
        attemptId:     TEST_ATTEMPT_ID,
        token:         'MOCK_AZURE_TOKEN_NOT_REAL',
        region:        'eastus',
        language:      'en-US',
        referenceText: TEST_REFERENCE_TEXT,
      }),
    });
  });
}

/**
 * Mocks /api/pronunciation/complete to return success.
 */
export async function mockPronunciationComplete(page: Page) {
  await page.route('/api/pronunciation/complete', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Cache-Control': 'no-store' },
      body: JSON.stringify({
        assessmentId: TEST_ASSESSMENT_ID,
        status:       'completed',
        result:       FAKE_RESULT,
      }),
    });
  });
}

/**
 * Mocks /api/pronunciation/fail to return success.
 */
export async function mockPronunciationFail(page: Page) {
  await page.route('/api/pronunciation/fail', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'failed' }),
    });
  });
}
