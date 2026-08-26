/**
 * Static assertions that the pre-conversation choices (language + mode) are
 * persisted as USER PREFERENCES on ai_conversation_preferences and are editable
 * from Personalizar tutor — so they survive app restart / logout / device change
 * (backend row, not localStorage) and drive first-use detection.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const hookSrc = readFileSync(resolve(__dirname, '..', '..', 'hooks', 'useTutorPreferences.ts'), 'utf8');
const sheetSrc = readFileSync(resolve(__dirname, '..', 'TutorPersonalizationSheet.tsx'), 'utf8');
const migSql = readFileSync(
  resolve(__dirname, '..', '..', '..', 'supabase', 'migrations', '20260826180000_conversation_session_mode_preference.sql'),
  'utf8',
);

describe('useTutorPreferences — conversation prefs persisted to the backend row', () => {
  it('reads both columns (language legacy-normalized) from ai_conversation_preferences', () => {
    expect(hookSrc).toMatch(/conversationLanguageMode: normalizeConversationLanguageMode\(row\.conversation_language_mode\)/);
    expect(hookSrc).toMatch(/row\.conversation_session_mode === 'guided' \|\| row\.conversation_session_mode === 'free'/);
  });

  it('writes both columns on save (prefsToRow)', () => {
    expect(hookSrc).toMatch(/conversation_language_mode: p\.conversationLanguageMode/);
    expect(hookSrc).toMatch(/conversation_session_mode:  p\.conversationSessionMode/);
  });

  it('exposes first-use detection derived from the persisted pref (not localStorage)', () => {
    expect(hookSrc).toMatch(/conversationConfigured: saved\.conversationLanguageMode !== null/);
    expect(hookSrc).not.toContain('localStorage');
  });

  it('saveConversationPrefs writes a COMPLETE row merged over the last-saved prefs and upserts by user_id', () => {
    expect(hookSrc).toContain('const merged: AIPreferences = { ...savedRef.current, ...updates };');
    expect(hookSrc).toMatch(/\.upsert\(prefsToRow\(merged\), \{ onConflict: 'user_id' \}\)/);
    expect(hookSrc).toContain('setSaved(merged)');
  });

  it('resetToDefault preserves the conversation choices (only tutor personality resets)', () => {
    expect(hookSrc).toMatch(/conversationLanguageMode: saved\.conversationLanguageMode/);
    expect(hookSrc).toMatch(/conversationSessionMode: saved\.conversationSessionMode/);
  });
});

describe('Personalizar tutor — editable Conversa tab', () => {
  it('has a "Conversa" tab that updates language + mode', () => {
    expect(sheetSrc).toMatch(/id: 'conversa',\s*label: 'Conversa'/);
    expect(sheetSrc).toContain('<ConversaSection');
    expect(sheetSrc).toMatch(/update\(\{ conversationLanguageMode: v \}\)/);
    expect(sheetSrc).toMatch(/update\(\{ conversationSessionMode: v \}\)/);
  });

  it('offers the two language options and the two mode options', () => {
    expect(sheetSrc).toContain("id: 'target_only'");
    expect(sheetSrc).toContain("id: 'bilingual_support'");
    expect(sheetSrc).toContain("id: 'guided'");
    expect(sheetSrc).toContain("id: 'free'");
  });
});

describe('migration — conversation_session_mode preference column', () => {
  it('adds a nullable checked column to ai_conversation_preferences', () => {
    expect(migSql).toMatch(/ALTER TABLE public\.ai_conversation_preferences\s*ADD COLUMN IF NOT EXISTS conversation_session_mode text/);
    expect(migSql).toMatch(/conversation_session_mode IN \('guided', 'free'\)/);
  });
});
