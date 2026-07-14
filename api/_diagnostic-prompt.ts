/**
 * SERVER-ONLY: Prompt do gerador diagnóstico de escrita v1.
 *
 * Estende o gerador normal com instruções invisíveis ao usuário.
 * O resultado final é idêntico em formato ao modo normal —
 * apenas adiciona o campo "internalCoverage" que é removido pelo DTO.
 */

import type { WritingDiagnosticMissionPlan } from '../src/domain/diagnostic/writing-diagnostic-types';

export const DIAGNOSTIC_PROMPT_VERSION = 'v1' as const;

/**
 * Extensão do system prompt para modo diagnóstico.
 * Este texto é concatenado ao SYSTEM_PROMPT normal.
 * NUNCA aparece no output retornado ao usuário.
 */
export const DIAGNOSTIC_SYSTEM_PROMPT_EXTENSION = `

═══ MODO DIAGNÓSTICO INVISÍVEL (INTERNO — NÃO REVELAR AO USUÁRIO) ═══

Você está em modo diagnóstico. O usuário NÃO sabe disso.

REGRAS ABSOLUTAS DO MODO DIAGNÓSTICO:
1. A missão deve parecer COMPLETAMENTE NORMAL para o aluno — idêntica às outras.
2. NUNCA mencione nível, CEFR, A1, A2, B1, B2, C1, C2 na missão pública.
3. NUNCA mencione diagnóstico, avaliação, teste, classificação ou pontuação.
4. NUNCA peça explicitamente que o aluno use um tempo verbal específico.
5. NUNCA mencione present perfect, past perfect, conditional, passive voice.
6. A missão deve poder ser respondida por um iniciante com frases simples.
7. A missão deve TAMBÉM permitir que um aluno avançado revele mais capacidade.

EXEMPLO de missão diagnóstica CORRETA (invisível):
  Setup: "Você havia planejado encontrar um amigo, mas ele cancelou na última hora sem explicar o motivo."
  Task: "Escreva uma mensagem para ele explicando como você se sentiu e o que decidiu fazer no lugar."
  → Iniciante pode escrever: "I was sad. I stayed home."
  → Avançado pode escrever: "Although I had already organized my evening, he cancelled without any explanation, which was quite frustrating."
  → Nenhum nível é citado. Nenhuma gramática é exigida.

EXEMPLO de missão diagnóstica ERRADA (revela diagnóstico):
  "Use present perfect para descrever o que aconteceu. Seu nível é A2, então use..."
  → PROIBIDO.

═══ CAMPO ADICIONAL OBRIGATÓRIO: internalCoverage ═══

Além dos campos normais, inclua no JSON:

"internalCoverage": [
  {
    "objectiveId": "string (ID do objetivo diagnóstico coberto)",
    "coverageExplanation": "string (1 frase explicando como esta missão elicita este objetivo)"
  }
]

IMPORTANTE sobre internalCoverage:
- Este campo é para uso INTERNO do sistema — nunca será exibido ao aluno.
- Liste apenas os objetivos que esta missão genuinamente cobre.
- Use APENAS os IDs fornecidos em diagnosticObjectiveIds abaixo.
- Seja honesto: se a missão não cobre um objetivo, não liste ele.`;

/**
 * Constrói a seção de objetivos diagnósticos para o user message.
 * Esta seção é interna e nunca aparece no output público.
 */
export function buildDiagnosticUserMessageSection(
  plan: WritingDiagnosticMissionPlan,
  recentDiagnosticThemeTitles: string[],
): string {
  const lines: string[] = [];

  lines.push('');
  lines.push('═══ CONTEXTO DIAGNÓSTICO INTERNO (NÃO INCLUIR NA MISSÃO PÚBLICA) ═══');
  lines.push(`Sequência diagnóstica: ${plan.diagnosticSequence} de 2`);
  lines.push('');

  lines.push('Funções comunicativas que a situação DEVE elicitar naturalmente:');
  plan.requiredCommunicativeFunctions.forEach(f => lines.push(`  • ${f}`));

  lines.push('');
  lines.push('Sinais de produção avançada (opcionais — não force):');
  plan.optionalStretchSignals.forEach(s => lines.push(`  • ${s}`));

  lines.push('');
  lines.push('IDs dos objetivos diagnósticos a cobrir (use em internalCoverage):');
  plan.objectives.forEach(obj => {
    const req = obj.required ? '[OBRIGATÓRIO]' : '[OPCIONAL]';
    lines.push(`  ${req} ${obj.id}: ${obj.elicitationStrategy}`);
  });

  lines.push('');
  lines.push('Instruções PROIBIDAS na missão pública:');
  plan.forbiddenExplicitInstructions.slice(0, 8).forEach(i => lines.push(`  ❌ ${i}`));

  if (recentDiagnosticThemeTitles.length > 0) {
    lines.push('');
    lines.push('Temas diagnósticos anteriores (EVITAR REPETIÇÃO SEMÂNTICA):');
    recentDiagnosticThemeTitles.forEach((t, i) => lines.push(`  [${i + 1}] "${t}"`));
  }

  lines.push('');
  lines.push('RESTRIÇÕES DE CONTEÚDO:');
  const c = plan.contentConstraints;
  if (c.requireEverydaySituation) lines.push('  ✓ Exige situação cotidiana concreta');
  if (c.requireConflictOrDecision) lines.push('  ✓ Exige conflito, decisão, imprevisto ou consequência');
  if (c.avoidGenericSelfIntroduction) lines.push('  ❌ Proibido: tema de apresentação pessoal genérico');
  if (c.avoidGrammarTestLanguage) lines.push('  ❌ Proibido: linguagem de teste gramatical');

  return lines.join('\n');
}
