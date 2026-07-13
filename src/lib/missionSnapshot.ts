import { EnglishDailyTheme, MissionSnapshot, VocabularyItem, ResponseExample, CefrLevel } from '../types';

export function buildMissionSnapshot(theme: EnglishDailyTheme): MissionSnapshot {
  const requiredWords = [
    ...(Array.isArray(theme.useTheseWords) ? theme.useTheseWords : []),
    ...(Array.isArray(theme.requiredWords) ? theme.requiredWords : []),
  ];
  // Deduplicate
  const uniqueRequiredWords = [...new Set(requiredWords)];

  return {
    missionTitle: theme.title,
    missionSetup: theme.missionSetup ?? null,
    missionTask: theme.missionTask ?? null,
    missionPromptPt: theme.mission ?? theme.themePtBr ?? null,
    missionPromptEn: theme.themeEn ?? null,
    missionConflict: theme.conflict ?? null,
    missionGoal: theme.objective ?? null,
    missionInstructions: Array.isArray(theme.instructions) ? theme.instructions : [],
    missionGrammarTopics: Array.isArray(theme.requiredGrammar) ? theme.requiredGrammar : [],
    missionUsefulVocabulary: Array.isArray(theme.suggestedVocabulary) ? theme.suggestedVocabulary : [],
    missionRequiredWords: uniqueRequiredWords,
    missionExampleAnswers: Array.isArray(theme.responseExamples) ? theme.responseExamples : [],
    missionCompletionCriteria: Array.isArray(theme.successCriteria) ? theme.successCriteria : [],
    missionExtraChallenge: theme.extraChallenge ?? null,
    missionDifficulty: theme.difficulty ?? null,
    missionLevel: theme.level ?? null,
    missionFormat: theme.format ?? theme.activityType ?? null,
    missionContext: theme.context ?? null,
    missionGeneratedAt: new Date().toISOString(),
  };
}

export function parseMissionSnapshot(raw: unknown): MissionSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  // New MissionSnapshot format
  if (typeof r.missionTitle === 'string') {
    return {
      missionTitle: r.missionTitle,
      missionSetup: r.missionSetup ? String(r.missionSetup) : null,
      missionTask: r.missionTask ? String(r.missionTask) : null,
      missionPromptPt: r.missionPromptPt ? String(r.missionPromptPt) : null,
      missionPromptEn: r.missionPromptEn ? String(r.missionPromptEn) : null,
      missionConflict: r.missionConflict ? String(r.missionConflict) : null,
      missionGoal: r.missionGoal ? String(r.missionGoal) : null,
      missionInstructions: Array.isArray(r.missionInstructions) ? (r.missionInstructions as string[]) : [],
      missionGrammarTopics: Array.isArray(r.missionGrammarTopics) ? (r.missionGrammarTopics as string[]) : [],
      missionUsefulVocabulary: Array.isArray(r.missionUsefulVocabulary) ? (r.missionUsefulVocabulary as VocabularyItem[]) : [],
      missionRequiredWords: Array.isArray(r.missionRequiredWords) ? (r.missionRequiredWords as string[]) : [],
      missionExampleAnswers: Array.isArray(r.missionExampleAnswers) ? (r.missionExampleAnswers as ResponseExample[]) : [],
      missionCompletionCriteria: Array.isArray(r.missionCompletionCriteria) ? (r.missionCompletionCriteria as string[]) : [],
      missionExtraChallenge: r.missionExtraChallenge ? String(r.missionExtraChallenge) : null,
      missionDifficulty: (r.missionDifficulty as 'easy' | 'medium' | 'hard') ?? null,
      missionLevel: (r.missionLevel as CefrLevel) ?? null,
      missionFormat: r.missionFormat ? String(r.missionFormat) : null,
      missionContext: r.missionContext ? String(r.missionContext) : null,
      missionGeneratedAt: r.missionGeneratedAt ? String(r.missionGeneratedAt) : new Date().toISOString(),
    };
  }

  // Legacy format: old EnglishDailyTheme saved directly as JSONB
  if (typeof r.title === 'string') {
    return buildMissionSnapshot(r as unknown as EnglishDailyTheme);
  }

  return null;
}
