/**
 * Static assertions on the conversation-language-mode generalization migrations.
 * They don't run SQL; they lock in the structural invariants: generalized +
 * legacy CHECK union, preference normalization, and the DATA-DRIVEN bilingual
 * support template (pedagogical prose lives here, not in TypeScript).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateTemplateRequires, extractPlaceholders } from '../../../src/domain/curriculum-engine/template-engine';

const MIG = join(__dirname, '..');
const read = (f: string) => readFileSync(join(MIG, f), 'utf8');

describe('20260826120000 — base columns (nullable, frozen per session)', () => {
  const sql = read('20260826120000_conversation_language_mode.sql');
  it('adds a nullable conversation_language_mode to both tables', () => {
    expect(sql).toMatch(/ALTER TABLE public\.conversation_session_authorizations[\s\S]*ADD COLUMN IF NOT EXISTS conversation_language_mode text/);
    expect(sql).toMatch(/ALTER TABLE public\.ai_conversation_preferences[\s\S]*ADD COLUMN IF NOT EXISTS conversation_language_mode text/);
  });
});

describe('20260826140000 — generalization + data-driven template', () => {
  const sql = read('20260826140000_conversation_language_mode_generalize.sql');

  it('drops any existing check on the column before recreating (safe rename)', () => {
    expect(sql).toMatch(/pg_get_constraintdef\(con\.oid\) ILIKE '%conversation_language_mode%'/);
    expect(sql).toMatch(/DROP CONSTRAINT %I/);
  });

  it('CHECK accepts BOTH generalized and legacy values (no broken rows/history)', () => {
    for (const table of ['conversation_session_authorizations', 'ai_conversation_preferences']) {
      const block = sql.slice(sql.indexOf(`ALTER TABLE public.${table}\n  ADD CONSTRAINT`));
      expect(block).toContain("'target_only'");
      expect(block).toContain("'bilingual_support'");
      expect(block).toContain("'english_only'");
      expect(block).toContain("'bilingual_pt_en'");
    }
  });

  it('normalizes the mutable PREFERENCE legacy → generalized (not the auth history)', () => {
    expect(sql).toMatch(/UPDATE public\.ai_conversation_preferences\s*SET conversation_language_mode = 'target_only'\s*WHERE conversation_language_mode = 'english_only'/);
    expect(sql).toMatch(/UPDATE public\.ai_conversation_preferences\s*SET conversation_language_mode = 'bilingual_support'\s*WHERE conversation_language_mode = 'bilingual_pt_en'/);
    // Session authorizations (history) are NOT rewritten.
    expect(sql).not.toMatch(/UPDATE public\.conversation_session_authorizations\s*SET conversation_language_mode/);
  });

  it('seeds the composable bilingual template via the SAME prompt_templates mechanism', () => {
    expect(sql).toMatch(/INSERT INTO public\.prompt_templates/);
    expect(sql).toContain("'conversation.bilingual_support', 'en', 'pt-BR', 1, 'published'");
    expect(sql).toContain('ON CONFLICT (template_key, learning_language, interface_language, version)');
  });

  // Extract the template body ($tpl$...$tpl$) and validate it as a real template.
  const body = (() => {
    const m = sql.match(/\$tpl\$([\s\S]*?)\$tpl\$/);
    return m ? m[1] : '';
  })();

  it('the template body is parameterized by the language pair + level (NOT a fixed pair)', () => {
    expect(body).toContain('{{target_label}}');
    expect(body).toContain('{{support_label}}');
    expect(body).toContain('{{level}}');
    // No hardcoded language pair in the pedagogical text.
    expect(body).not.toMatch(/\bpt_en\b|\bes_en\b|\bpt_es\b/);
    // Declared required placeholders actually appear in the body.
    validateTemplateRequires(body, ['target_label', 'support_label', 'level']);
    expect(extractPlaceholders(body).sort()).toEqual(['level', 'support_label', 'target_label']);
  });

  it('encodes the bilingual pedagogy in DATA: goal, support, steer-back, corrections, "como falo X", level adaptation', () => {
    expect(body).toMatch(/PRODUZIR \{\{target_label\}\}/);            // goal is the target language
    expect(body).toMatch(/\{\{support_label\}\} é apoio/);            // base is only support
    expect(body).toMatch(/reconduza o aluno a responder em \{\{target_label\}\}/); // steer back
    expect(body).toMatch(/forma correta em \{\{target_label\}\}/);   // corrections in target
    expect(body).toMatch(/como eu falo X/i);                          // "how do I say X"
    expect(body).toMatch(/A1\/A2/);                                    // beginner simplification
  });
});

describe('20260826160000 — PROACTIVE bilingual template (data-only prompt upgrade)', () => {
  const sql = read('20260826160000_conversation_bilingual_template_proactive.sql');
  const body = (() => {
    const m = sql.match(/\$tpl\$([\s\S]*?)\$tpl\$/);
    return m ? m[1] : '';
  })();

  it('re-seeds the SAME template key idempotently (ON CONFLICT DO UPDATE)', () => {
    expect(sql).toContain("'conversation.bilingual_support', 'en', 'pt-BR', 1, 'published'");
    expect(sql).toContain('ON CONFLICT (template_key, learning_language, interface_language, version)');
    expect(sql).toContain('DO UPDATE SET');
  });

  it('stays parameterized (no hardcoded language pair) with the same placeholders', () => {
    expect(body).toContain('{{target_label}}');
    expect(body).toContain('{{support_label}}');
    expect(body).toContain('{{level}}');
    expect(body).not.toMatch(/\bpt_en\b|\bes_en\b|\bpt_es\b/);
    validateTemplateRequires(body, ['target_label', 'support_label', 'level']);
    expect(extractPlaceholders(body).sort()).toEqual(['level', 'support_label', 'target_label']);
  });

  it('is PROACTIVE + authoritative: max priority, opens in the support language incl. the first turn', () => {
    expect(body).toMatch(/PRIORIDADE MÁXIMA/i);
    expect(body).toMatch(/Ignore qualquer instrução anterior/i);
    expect(body).toMatch(/PRIMEIRA fala/i);                                  // applies to the greeting
    expect(body).toMatch(/Comece acolhendo e explicando a proposta em \{\{support_label\}\}/);
    expect(body).toMatch(/NÃO abra a conversa apenas em \{\{target_label\}\}/);
  });

  it('keeps the core rules as DATA (goal, steer-back, corrections, como falo X, level)', () => {
    expect(body).toMatch(/PRODUZIR \{\{target_label\}\}/);
    expect(body).toMatch(/reconduza o aluno a responder em \{\{target_label\}\}/);
    expect(body).toMatch(/como eu falo X/i);
    expect(body).toMatch(/forma correta em \{\{target_label\}\}/);
    expect(body).toMatch(/\{\{level\}\}/);
    expect(body).toMatch(/A1\/A2/);
  });
});

describe('20260827120000 — DETERMINISTIC bilingual language rule (no random switching)', () => {
  const sql = read('20260827120000_conversation_bilingual_directive_consistency.sql');
  const body = (() => {
    const m = sql.match(/\$tpl\$([\s\S]*?)\$tpl\$/);
    return m ? m[1] : '';
  })();

  it('re-seeds the same template idempotently, still parameterized', () => {
    expect(sql).toContain("'conversation.bilingual_support', 'en', 'pt-BR', 1, 'published'");
    expect(sql).toContain('ON CONFLICT');
    validateTemplateRequires(body, ['target_label', 'support_label', 'level']);
    expect(extractPlaceholders(body).sort()).toEqual(['level', 'support_label', 'target_label']);
    expect(body).not.toMatch(/\bpt_en\b|\bes_en\b|\bpt_es\b/);
  });

  it('makes the tutor CONDUCT in the support language and use the target only for practice items', () => {
    expect(body).toMatch(/NUNCA ALTERNE AO ACASO/i);
    expect(body).toMatch(/TODA a sua fala de condução[\s\S]*em \{\{support_label\}\}/);
    expect(body).toMatch(/Use \{\{target_label\}\} SOMENTE/);
    expect(body).toMatch(/Nunca conduza a conversa em \{\{target_label\}\} com um aluno A1\/A2/i);
  });

  it('scales by level (A1/A2 strict → C1/C2 majority target)', () => {
    expect(body).toMatch(/A1\/A2:/);
    expect(body).toMatch(/C1\/C2:/);
  });
});

describe('20260827130000 — guided tutor must ADVANCE (anti-repetition)', () => {
  const sql = read('20260827130000_conversation_guided_progression.sql');

  it('adds a progression / anti-repetition rule to conversation.tutor', () => {
    expect(sql).toMatch(/template_key = 'conversation\.tutor'/);
    expect(sql).toContain('MOVING FORWARD');
    expect(sql).toMatch(/NEVER repeat the same sentence/i);
    expect(sql).toMatch(/Do not get stuck drilling a single phrase/i);
    // Applied via replace() on the exact existing sentence (idempotent).
    expect(sql).toContain('Provoke situations that require the target capability.');
  });
});

describe('20260827140000 — bilingual: feedback in support lang, translate once, no echo', () => {
  const sql = read('20260827140000_conversation_bilingual_less_translation_no_echo.sql');
  const body = (() => {
    const m = sql.match(/\$tpl\$([\s\S]*?)\$tpl\$/);
    return m ? m[1] : '';
  })();

  it('keeps the template parameterized (no hardcoded pair) with the same placeholders', () => {
    expect(sql).toContain("'conversation.bilingual_support', 'en', 'pt-BR', 1, 'published'");
    expect(sql).toContain('ON CONFLICT');
    validateTemplateRequires(body, ['target_label', 'support_label', 'level']);
    expect(body).not.toMatch(/\bpt_en\b|\bes_en\b|\bpt_es\b/);
  });

  it('forces feedback/corrections into the support language (no English "Nice try")', () => {
    expect(body).toMatch(/ELOGIOS, FEEDBACK/);
    expect(body).toMatch(/NUNCA dê feedback em \{\{target_label\}\}/i);
  });

  it('limits translation (once, never obvious, never repeat)', () => {
    expect(body).toMatch(/no máximo UMA vez/i);
    expect(body).toMatch(/NÃO traduza palavras\/expressões óbvias/i);
    expect(body).toMatch(/NUNCA repita a tradução/i);
  });

  it('forbids echoing/re-translating the learner', () => {
    expect(body).toMatch(/NÃO ECOE O ALUNO/i);
    expect(body).toMatch(/NÃO repita a fala dele nem a traduza de volta/i);
  });
});

describe('20260826200000 — base templates use a single {{conversation_language_directive}}', () => {
  const sql = read('20260826200000_conversation_templates_language_directive.sql');

  it('removes the guided hardcoded NON-NEGOTIABLE language rule, replacing it with the placeholder', () => {
    // The exact block being removed is referenced as the replace() source…
    expect(sql).toContain('=== OUTPUT LANGUAGE (NON-NEGOTIABLE) ===');
    expect(sql).toContain('Never switch the conversation itself to {{interface_language_name}}.');
    // …and the target of that replace is the data-driven placeholder.
    expect(sql).toContain('{{conversation_language_directive}}');
    expect(sql).toMatch(/template_key = 'conversation\.tutor'/);
  });

  it('replaces the free hardcoded "Responda SEMPRE em" language lines with the placeholder', () => {
    expect(sql).toContain('- Responda SEMPRE em {{learning_label}}, mesmo que o aprendiz escreva em outro idioma.');
    expect(sql).toMatch(/template_key = 'conversation\.free'/);
  });

  it('only adds the required placeholder WHERE the body actually contains it (guard against divergence)', () => {
    expect(sql).toMatch(/system_body LIKE '%\{\{conversation_language_directive\}\}%'/);
    expect(sql).toContain("'conversation_language_directive'");
  });
});
