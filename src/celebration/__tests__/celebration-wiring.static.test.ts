/**
 * Static source assertions for the celebration integration points. This repo has
 * no DOM/component harness (vitest env is 'node'), so — following the repo's
 * existing *-wiring.static.test convention — we prove the wiring with source-text
 * assertions. The behavioral guarantees (activity vs day, dedup) are covered by
 * the behavioral suites (decideCelebrationLevel / resolveCelebration / dedup).
 *
 * What matters here: every trigger sits AFTER a confirmed/persisted completion
 * (never optimistically, never on mount/reload/re-entry), so an incomplete or
 * already-completed activity never celebrates.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const src = (rel: string) => readFileSync(resolve(__dirname, '..', '..', rel), 'utf8');

const main = src('main.tsx');
const listening = src('components/ListeningView.tsx');
const conversation = src('components/ConversationView.tsx');
const pronTraining = src('components/PronunciationTrainingView.tsx');
const pronDiary = src('components/PronunciationRecorder.tsx');
const dayView = src('components/DayView.tsx');
const errorReview = src('components/ErrorReviewView.tsx');

describe('provider is mounted once, above the whole app', () => {
  it('main.tsx wraps <App/> in <CelebrationProvider> so the overlay covers every screen', () => {
    expect(main).toMatch(/import \{ CelebrationProvider \} from '\.\/celebration'/);
    expect(main).toMatch(/<CelebrationProvider>[\s\S]*<App \/>[\s\S]*<\/CelebrationProvider>/);
  });
});

describe('Listening — celebrates only a genuine (not already-completed) transition', () => {
  it('uses the celebration hook', () => {
    expect(listening).toMatch(/const celebration = useCelebration\(\)/);
  });
  it('both completion sites guard on !alreadyCompleted before notifying', () => {
    const matches = listening.match(
      /if \(!completion\.alreadyCompleted\) celebration\.notifyActivityCompleted\('listening'\)/g,
    );
    expect(matches?.length).toBe(2); // handleStorySubmit + renderCycleFailed advance
  });
  it('the notify happens AFTER awaiting the server persist (never optimistic)', () => {
    expect(listening).toMatch(
      /const completion = await completeStoryListening[\s\S]{0,200}?notifyActivityCompleted\('listening'\)/,
    );
  });
});

describe('Conversation — optional, celebrated immediately on end-of-session (decoupled from the server call)', () => {
  it('is guarded by recordingAuthorizationId', () => {
    expect(conversation).toMatch(
      /if \(session\.recordingAuthorizationId\) \{[\s\S]{0,120}?celebration\.notifyActivityCompleted\('conversation'\)/,
    );
  });
  it('fires BEFORE completeConversationSession (not inside its .then) so it never waits on the server', () => {
    const celebrateAt = conversation.indexOf("celebration.notifyActivityCompleted('conversation')");
    const completeAt = conversation.indexOf('completeConversationSession(session.recordingAuthorizationId)');
    expect(celebrateAt).toBeGreaterThan(-1);
    expect(completeAt).toBeGreaterThan(-1);
    expect(celebrateAt).toBeLessThan(completeAt);
  });
});

describe('Pronunciation training — only the fresh analysis, once', () => {
  it('is guarded by celebratedRef inside the completed branch (resume path never celebrates)', () => {
    expect(pronTraining).toMatch(
      /if \(!celebratedRef\.current\) \{[\s\S]{0,120}?notifyActivityCompleted\('pronunciation'\)/,
    );
    // reset per analysis so a brand-new session can celebrate again
    expect(pronTraining).toMatch(/celebratedRef\.current = false/);
  });
});

describe('Pronunciation diary — only the fresh flow, never the mount-restore', () => {
  it('notifies inside the runAnalysisFlow progress callback on phase === completed', () => {
    expect(pronDiary).toMatch(
      /if \(state\.phase === 'completed'\) celebration\.notifyActivityCompleted\('pronunciation'\)/,
    );
  });
  it('the statusData mount-restore effect does NOT contain a celebration call', () => {
    const restoreEffect = pronDiary.slice(
      pronDiary.indexOf('// Apply status data to analysis'),
      pronDiary.indexOf('// Best-effort /fail'),
    );
    expect(restoreEffect).not.toMatch(/notifyActivityCompleted/);
  });
});

describe('Writing — celebrated at Conclude, for TODAY only', () => {
  it('notifies only when there is a review and the entry is today', () => {
    expect(dayView).toMatch(
      /if \(reviewId && date === getTodaySP\(\)\) celebration\.notifyActivityCompleted\('writing'\)/,
    );
  });
});

describe('Error review — optional, once per finished session', () => {
  it('notifies on the session-done transition, gated on having answered items', () => {
    expect(errorReview).toMatch(
      /setPhase\('done'\);[\s\S]{0,180}?if \(total > 0\) celebration\.notifyActivityCompleted\('review'\)/,
    );
  });
});
