import { getCurriculumProgress } from './curriculumApi';

/**
 * The current user's interface language from the OFFICIAL, server-authoritative
 * source (the same /api/curriculum/progress payload Home and the conversation
 * chooser read via useCurriculumFocus) — NOT a parallel language store. Used by
 * non-React flows that must localize outside a render, e.g. the practice-reminder
 * login/resume re-sync. Returns null (never a hardcoded default) when no valid
 * language can be resolved, leaving the fallback decision to the i18n resolver.
 */
export async function getCurrentInterfaceLanguage(): Promise<string | null> {
  try {
    const progress = await getCurriculumProgress();
    const lang = progress?.interfaceLanguage;
    return typeof lang === 'string' && lang.trim().length > 0 ? lang : null;
  } catch {
    return null;
  }
}
