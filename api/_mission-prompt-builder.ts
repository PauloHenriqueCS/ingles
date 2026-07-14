/**
 * SERVER-ONLY: Builds pedagogically-constrained prompt sections for mission generation.
 *
 * Injects the pedagogical plan's constraints into the AI prompt so the generator
 * respects the learner's level, forbidden topics, and communicative objective.
 */

import type { MissionPedagogicalPlan } from '../src/domain/pedagogy/planner/planner-types';

/**
 * Builds the plan constraints section to be appended to the user message.
 * Only called when PEDAGOGICAL_GENERATOR_INTEGRATION_V1=enabled.
 */
export function buildPlanConstraintsSection(plan: MissionPedagogicalPlan): string {
  const lines: string[] = [];

  lines.push('');
  lines.push('═══ PLANO PEDAGÓGICO OBRIGATÓRIO ═══');
  lines.push('');
  lines.push(`Nível-alvo do aluno: ${plan.effectiveLevel}`);
  lines.push(`Dificuldade da missão: ${plan.difficulty}`);
  lines.push(`O campo "level" no JSON deve ser exatamente: "${plan.effectiveLevel}"`);
  lines.push(`O campo "difficulty" no JSON deve ser exatamente: "${plan.difficulty}"`);

  if (plan.communicativeFunctions.length > 0) {
    lines.push('');
    lines.push('Objetivo comunicativo que esta missão deve atingir:');
    plan.communicativeFunctions.forEach(f => lines.push(`  - ${f}`));
  }

  if (plan.generationConstraints.preferredContextFamilies.length > 0) {
    lines.push('');
    lines.push(
      `Contextos narrativos preferidos (escolha um): ${plan.generationConstraints.preferredContextFamilies.join(', ')}`,
    );
  }

  if (plan.generationConstraints.avoidedContextFamilies.length > 0) {
    lines.push('');
    lines.push(
      `Contextos a evitar (usados recentemente): ${plan.generationConstraints.avoidedContextFamilies.join(', ')}`,
    );
  }

  if (plan.generationConstraints.forbiddenInstructions.length > 0) {
    lines.push('');
    lines.push('Restrições pedagógicas obrigatórias:');
    plan.generationConstraints.forbiddenInstructions.forEach(f => lines.push(`  ❌ ${f}`));
  }

  if (plan.generationConstraints.requireConflictDecisionOrUnexpectedEvent) {
    lines.push('');
    lines.push('✅ A missão DEVE conter um conflito, uma decisão ou um evento inesperado.');
  }

  if (plan.generationConstraints.avoidExplicitGrammarExercise) {
    lines.push('');
    lines.push('❌ NÃO peça ao aluno para demonstrar, praticar ou usar explicitamente uma estrutura gramatical.');
    lines.push('   A gramática deve emergir naturalmente da situação, não ser o objetivo declarado.');
  }

  lines.push('');
  lines.push('Atenção: o JSON gerado será validado automaticamente. Missões que violarem estas regras serão rejeitadas.');

  return lines.join('\n');
}

/**
 * Builds the repair section for the second attempt after validation failure.
 * Appended after the plan constraints section.
 */
export function buildRepairSection(
  plan: MissionPedagogicalPlan,
  rejectionDetail: string,
): string {
  const lines: string[] = [];

  lines.push('');
  lines.push('═══ MISSÃO REJEITADA — CORRIJA E REESCREVA ═══');
  lines.push('');
  lines.push('A tentativa anterior foi rejeitada pelo validador pedagógico:');
  lines.push(`  Motivo: ${rejectionDetail}`);
  lines.push('');
  lines.push('Gere uma missão COMPLETAMENTE DIFERENTE que corrija o problema acima.');
  lines.push(buildPlanConstraintsSection(plan));

  return lines.join('\n');
}
