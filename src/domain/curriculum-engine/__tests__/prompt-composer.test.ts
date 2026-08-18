import { describe, it, expect } from 'vitest';
import { composePrompt } from '../prompt-composer';
import { TemplateValidationError } from '../template-engine';
import type { PromptTemplate, CurriculumModule, CurriculumSubtopic, LevelGenerationRule } from '../types';

function template(over: Partial<PromptTemplate> = {}): PromptTemplate {
  return {
    templateKey: 'writing.generate_topic',
    learningLanguage: 'en',
    interfaceLanguage: 'pt-BR',
    version: 1,
    model: null,
    temperature: 0.8,
    systemBody:
      'Teach {{learning_language}} (interface {{interface_language}}) at {{level}}. ' +
      'Capability: {{subtopic_capability}}. Support: {{language_targets}}. ' +
      'Words {{rule.word_count_min}}-{{rule.word_count_max}}.',
    userBody: 'Go.',
    requiredPlaceholders: ['learning_language', 'level', 'subtopic_capability'],
    ...over,
  };
}

const module: CurriculumModule = {
  id: 'm1', moduleKey: 'B1.OPINION', levelCode: 'B1', sortOrder: 3,
  title: 'Explicar minha opinião', capability: 'expressar e justificar opiniões',
};

const subtopic: CurriculumSubtopic = {
  id: 's1', moduleId: 'm1', subtopicKey: 'B1.OPINION.AGREE_DISAGREE', levelCode: 'B1', sortOrder: 2,
  capability: 'Concordar ou discordar de uma opinião de forma adequada',
  languageTargets: [
    { kind: 'support', sortOrder: 0, text: 'agreement / disagreement' },
    { kind: 'support', sortOrder: 1, text: 'although' },
  ],
};

const levelRule: LevelGenerationRule = {
  levelCode: 'B1', activityType: 'writing',
  ruleValue: { word_count_min: 70, word_count_max: 120 },
};

describe('prompt-composer (English)', () => {
  it('assembles template + language + level rule + module + subtopic + targets', () => {
    const out = composePrompt({
      template: template(),
      languageContext: { learningLanguage: 'en', interfaceLanguage: 'pt-BR' },
      module,
      subtopic,
      levelRule,
    });
    expect(out.system).toContain('Teach en');
    expect(out.system).toContain('interface pt-BR');
    expect(out.system).toContain('at B1');
    expect(out.system).toContain('Concordar ou discordar');
    expect(out.system).toContain('agreement / disagreement, although');
    expect(out.system).toContain('Words 70-120');
    expect(out.user).toBe('Go.');
    expect(out.temperature).toBe(0.8);
  });

  it('renders {{learning_language_name}} from userContext (the human-readable directive, not the code)', () => {
    // The fix: resolveActivityPrompt injects learning_language_name/interface_
    // language_name into userContext so templates emit "English", not "en".
    const out = composePrompt({
      template: template({
        systemBody: 'Write ONLY in {{learning_language_name}}; explanations in {{interface_language_name}}. Level {{level}}. Cap {{subtopic_capability}}.',
        requiredPlaceholders: ['learning_language_name', 'level', 'subtopic_capability'],
      }),
      languageContext: { learningLanguage: 'en', interfaceLanguage: 'pt-BR' },
      module,
      subtopic,
      levelRule,
      userContext: { learning_language_name: 'English', interface_language_name: 'Brazilian Portuguese' },
    });
    expect(out.system).toContain('Write ONLY in English');
    expect(out.system).toContain('explanations in Brazilian Portuguese');
    expect(out.system).not.toContain('Write ONLY in en');
  });

  it('throws (no silent fallback) when a required curricular value is empty', () => {
    const emptySub: CurriculumSubtopic = { ...subtopic, capability: '' };
    expect(() =>
      composePrompt({
        template: template(),
        languageContext: { learningLanguage: 'en', interfaceLanguage: 'pt-BR' },
        module,
        subtopic: emptySub,
        levelRule,
      }),
    ).toThrow(TemplateValidationError);
  });
});

// ===========================================================================
// ACCEPTANCE PROOF: a SECOND learning_language runs through the exact same code
// path with NO language-specific branch. This is the architectural guarantee
// behind the requirement "cadastrar um currículo de espanhol sem lógica
// pedagógica específica de espanhol no código".
// ===========================================================================
describe('prompt-composer — multilingual genericity (Spanish + interface English)', () => {
  it('composes a Spanish-learning / English-interface prompt with the same engine', () => {
    const esTemplate = template({
      learningLanguage: 'es',
      interfaceLanguage: 'en',
      systemBody:
        'Teach {{learning_language}} (interface {{interface_language}}) at {{level}}. ' +
        'Capability: {{subtopic_capability}}. Support: {{language_targets}}.',
      userBody: null,
    });
    const esModule: CurriculumModule = { ...module, moduleKey: 'B1.OPINION', title: 'Expresar mi opinión', capability: 'expresar opiniones' };
    const esSubtopic: CurriculumSubtopic = {
      ...subtopic,
      capability: 'Estar de acuerdo o en desacuerdo con una opinión',
      languageTargets: [{ kind: 'support', sortOrder: 0, text: 'acuerdo / desacuerdo' }],
    };

    const out = composePrompt({
      template: esTemplate,
      languageContext: { learningLanguage: 'es', interfaceLanguage: 'en' },
      module: esModule,
      subtopic: esSubtopic,
      levelRule: null,
    });

    expect(out.system).toContain('Teach es');
    expect(out.system).toContain('interface en');
    expect(out.system).toContain('Estar de acuerdo o en desacuerdo');
    expect(out.system).toContain('acuerdo / desacuerdo');
    // No English pedagogical content leaked from code:
    expect(out.system).not.toContain('Teach en');
  });

  it('a completely fictitious test language also works (proves no hardcoded language set)', () => {
    const xxTemplate = template({
      learningLanguage: 'xx',
      interfaceLanguage: 'zz',
      systemBody: 'lang={{learning_language}} iface={{interface_language}} lvl={{level}} cap={{subtopic_capability}}',
      userBody: null,
    });
    const out = composePrompt({
      template: xxTemplate,
      languageContext: { learningLanguage: 'xx', interfaceLanguage: 'zz' },
      module: { ...module, levelCode: 'L1' },
      subtopic: { ...subtopic, levelCode: 'L1', capability: 'do the thing' },
      levelRule: null,
    });
    expect(out.system).toBe('lang=xx iface=zz lvl=L1 cap=do the thing');
  });
});
