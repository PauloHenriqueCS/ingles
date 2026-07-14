import { CEFRLevel, cefrIndex } from '../curriculum/cefr';
import { LearnerSkillProfile } from './learner-skill-types';

/**
 * Deriva um nível geral a partir dos perfis de habilidade.
 *
 * Esta função é DERIVADA — nunca deve ser persistida como fonte da verdade.
 * Usar apenas para resumo visual; internamente o sistema opera por habilidade.
 *
 * Regra conservadora: retorna o menor nível classificado entre as habilidades
 * com status confirmado ou calibrado. Retorna null se não houver nenhuma
 * habilidade classificada.
 *
 * Nunca calcule média matemática de níveis CEFR — os índices numéricos
 * não têm semântica pedagógica válida para média.
 */
export function deriveOverallLearnerLevel(
  profiles: LearnerSkillProfile[],
): CEFRLevel | null {
  const classified = profiles.filter(
    p =>
      p.level != null &&
      (p.status === 'confirmed' || p.status === 'calibrating' || p.status === 'provisional'),
  );

  if (classified.length === 0) return null;

  return classified.reduce<CEFRLevel>((min, p) => {
    return cefrIndex(p.level!) < cefrIndex(min) ? p.level! : min;
  }, classified[0].level!);
}
