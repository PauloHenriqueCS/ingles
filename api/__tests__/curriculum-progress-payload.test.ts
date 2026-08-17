/**
 * The Home "Foco atual" data contract (/api/curriculum/progress):
 *  - surfaces the LOCALIZED recorte capability, never the technical key;
 *  - reflects the current recorte and changes when progression advances it;
 *  - handles initializing / completed / absent states without inventing a focus.
 */
import { describe, it, expect } from 'vitest';
import { buildCurriculumProgressPayload } from '../_curriculum/route-handler';

describe('buildCurriculumProgressPayload', () => {
  it('exposes the localized recorte capability as currentFocus (never the key)', () => {
    const p = buildCurriculumProgressPayload({
      status: 'active',
      currentSubtopicKey: 'A1.SELFINTRO.GREET',
      currentFocusCapability: 'Cumprimentar e apresentar-se',
      currentModuleTitle: 'Falar sobre si mesmo',
      interfaceLanguage: 'pt-BR',
      conversationInPlan: true,
      completedRecortes: 0,
      totalRecortes: 40,
    });
    expect(p.currentFocus).toBe('Cumprimentar e apresentar-se');
    expect(p.currentLevel).toBe('A1');
    expect(p.currentModuleTitle).toBe('Falar sobre si mesmo');
    // The technical key must never appear anywhere in the payload.
    expect(JSON.stringify(p)).not.toContain('A1.SELFINTRO.GREET');
  });

  it('NEVER surfaces the raw subtopic_key even if mistakenly passed as the capability', () => {
    const p = buildCurriculumProgressPayload({
      status: 'active',
      currentSubtopicKey: 'A1.SELFINTRO.GREET',
      currentFocusCapability: 'A1.SELFINTRO.GREET', // capability erroneously = key
      currentModuleTitle: null,
      interfaceLanguage: 'pt-BR',
      conversationInPlan: false,
      completedRecortes: 0,
      totalRecortes: 40,
    });
    expect(p.currentFocus).toBeNull();
  });

  it('changes currentFocus when the recorte advances (progression)', () => {
    const before = buildCurriculumProgressPayload({
      status: 'active', currentSubtopicKey: 'A1.SELFINTRO.GREET',
      currentFocusCapability: 'Cumprimentar e apresentar-se', currentModuleTitle: 'Falar sobre si mesmo',
      interfaceLanguage: 'pt-BR', conversationInPlan: true, completedRecortes: 0, totalRecortes: 40,
    });
    const after = buildCurriculumProgressPayload({
      status: 'active', currentSubtopicKey: 'A1.SELFINTRO.ORIGIN',
      currentFocusCapability: 'Dizer de onde você é', currentModuleTitle: 'Falar sobre si mesmo',
      interfaceLanguage: 'pt-BR', conversationInPlan: true, completedRecortes: 1, totalRecortes: 40,
    });
    expect(before.currentFocus).toBe('Cumprimentar e apresentar-se');
    expect(after.currentFocus).toBe('Dizer de onde você é');
    expect(after.currentFocus).not.toBe(before.currentFocus);
  });

  it('returns a null focus (not a fabricated one) while initializing / when absent', () => {
    const p = buildCurriculumProgressPayload({
      status: 'active', currentSubtopicKey: null, currentFocusCapability: null,
      currentModuleTitle: null, interfaceLanguage: 'pt-BR', conversationInPlan: false,
      completedRecortes: 0, totalRecortes: 0,
    });
    expect(p.currentFocus).toBeNull();
    expect(p.currentLevel).toBeNull();
  });

  it('carries the completed status through untouched (UI shows its own completion copy)', () => {
    const p = buildCurriculumProgressPayload({
      status: 'curriculum_completed', currentSubtopicKey: 'C2.MASTERY.REFINE',
      currentFocusCapability: 'Refinar seu domínio', currentModuleTitle: 'Domínio',
      interfaceLanguage: 'pt-BR', conversationInPlan: true, completedRecortes: 40, totalRecortes: 40,
    });
    expect(p.status).toBe('curriculum_completed');
  });

  it('passes interfaceLanguage and conversationInPlan through for the UI', () => {
    const p = buildCurriculumProgressPayload({
      status: 'active', currentSubtopicKey: 'A2.M.S', currentFocusCapability: 'Algo',
      currentModuleTitle: 'Mod', interfaceLanguage: 'en', conversationInPlan: true,
      completedRecortes: 3, totalRecortes: 40,
    });
    expect(p.interfaceLanguage).toBe('en');
    expect(p.conversationInPlan).toBe(true);
  });
});
