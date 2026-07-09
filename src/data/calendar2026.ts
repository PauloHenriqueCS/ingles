import { DaySchedule } from '../types';

const MONTH_GRAMMAR: Record<number, { verbTense: string; objective: string }> = {
  1: { verbTense: 'Present Simple', objective: 'Descrever hábitos, rotinas e fatos gerais' },
  2: { verbTense: 'Present Continuous', objective: 'Descrever ações em progresso e mudanças temporárias' },
  3: { verbTense: 'Past Simple', objective: 'Narrar eventos passados com início e fim definidos' },
  4: { verbTense: 'Past Continuous', objective: 'Descrever contexto e ações em andamento no passado' },
  5: { verbTense: 'Present Perfect', objective: 'Conectar experiências passadas ao presente' },
  6: { verbTense: 'Present Perfect Continuous', objective: 'Enfatizar a duração de ações recentes' },
  7: { verbTense: 'Past Perfect', objective: 'Narrar o que aconteceu antes de outro evento passado' },
  8: { verbTense: 'Future: will / going to', objective: 'Fazer previsões e expressar planos futuros' },
  9: { verbTense: 'Conditionals (1st & 2nd)', objective: 'Expressar condições, hipóteses e consequências' },
  10: { verbTense: 'Passive Voice', objective: 'Focar na ação em vez do agente' },
  11: { verbTense: 'Modal Verbs', objective: 'Expressar obrigação, possibilidade e conselho' },
  12: { verbTense: 'Revisão Geral', objective: 'Usar todos os tempos verbais de forma integrada' },
};

const MONDAY_TOPICS = [
  'Minha rotina matinal',
  'Minha família',
  'Minha saúde e bem-estar',
  'Minha casa e ambiente',
  'Uma memória especial',
  'Meus hobbies',
  'Minha rotina noturna',
  'Meus amigos próximos',
  'Meu estilo de vida',
  'Minhas metas pessoais',
  'Minha relação com dinheiro',
  'O que me faz feliz',
  'Meu ambiente de estudo',
];

const TUESDAY_TOPICS = [
  'Meu trabalho ou estudos',
  'Ferramentas digitais que uso',
  'Trabalho remoto',
  'Produtividade pessoal',
  'Redes sociais no meu dia',
  'Inteligência artificial',
  'Minha carreira no futuro',
  'Comunicação no trabalho',
  'Reuniões e apresentações',
  'Gerenciamento de tempo',
  'Aprender algo online',
  'Segurança digital',
  'Compras pela internet',
];

const WEDNESDAY_TOPICS = [
  'Um filme que adorei',
  'Música favorita',
  'Um livro memorável',
  'Esportes que pratico',
  'Uma viagem que fiz',
  'Séries que estou assistindo',
  'Um podcast interessante',
  'Arte e criatividade',
  'Jogos e entretenimento',
  'Uma viagem dos sonhos',
  'Festas e tradições',
  'Culinária e receitas',
  'Um show ou evento cultural',
];

const THURSDAY_TOPICS = [
  'Meio ambiente e sustentabilidade',
  'Educação e aprendizado',
  'Saúde pública',
  'Tecnologia e sociedade',
  'Trabalho no futuro',
  'Igualdade e diversidade',
  'Finanças pessoais',
  'Mobilidade urbana',
  'Moradia e cidade',
  'Alimentação saudável',
  'Saúde mental',
  'Cultura e identidade',
  'Mudanças climáticas',
];

const FRIDAY_TOPICS = [
  'Uma história de superação',
  'Um erro que me ensinou muito',
  'Uma conquista que me orgulha',
  'Um sonho que quero realizar',
  'Uma pessoa que admiro',
  'O que aprendi esse mês',
  'Uma decisão difícil',
  'Um desafio que superei',
  'Uma habilidade que desenvolvi',
  'Um momento de virada',
  'O que quero mudar',
  'Uma aventura que vivi',
  'Meu crescimento no inglês',
];

const TOPICS_BY_DOW: Record<number, string[]> = {
  1: MONDAY_TOPICS,
  2: TUESDAY_TOPICS,
  3: WEDNESDAY_TOPICS,
  4: THURSDAY_TOPICS,
  5: FRIDAY_TOPICS,
};

function getWeekOfYear(date: Date): number {
  const start = new Date(date.getFullYear(), 0, 1);
  const diff = date.getTime() - start.getTime();
  return Math.floor(diff / (7 * 24 * 60 * 60 * 1000));
}

export function getScheduleForDate(dateStr: string): DaySchedule | null {
  const date = new Date(dateStr + 'T12:00:00');
  if (date.getFullYear() !== 2026) return null;

  const dow = date.getDay();

  if (dow === 0) {
    return {
      date: dateStr,
      isWeekend: true,
      weekendActivity: 'descanso',
      theme: 'Domingo — Descanso',
      grammarObjective: 'Dia de descanso. Relaxe e recarregue as energias.',
      verbTense: '—',
    };
  }

  if (dow === 6) {
    return {
      date: dateStr,
      isWeekend: true,
      weekendActivity: 'revisao',
      theme: 'Sábado — Revisão da Semana',
      grammarObjective: 'Reler os textos da semana, identificar padrões e corrigir erros.',
      verbTense: 'Revisão',
    };
  }

  const month = date.getMonth() + 1;
  const grammar = MONTH_GRAMMAR[month];
  const topics = TOPICS_BY_DOW[dow] ?? MONDAY_TOPICS;
  const week = getWeekOfYear(date);
  const theme = topics[week % topics.length];

  return {
    date: dateStr,
    isWeekend: false,
    theme,
    grammarObjective: grammar.objective,
    verbTense: grammar.verbTense,
  };
}

export function getAllDatesInMonth(year: number, month: number): string[] {
  const dates: string[] = [];
  const daysInMonth = new Date(year, month, 0).getDate();
  for (let d = 1; d <= daysInMonth; d++) {
    dates.push(
      `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`
    );
  }
  return dates;
}

export function getWeekdaysInMonth(year: number, month: number): string[] {
  return getAllDatesInMonth(year, month).filter((dateStr) => {
    const dow = new Date(dateStr + 'T12:00:00').getDay();
    return dow !== 0 && dow !== 6;
  });
}

export const ALL_VERB_TENSES = Object.values(MONTH_GRAMMAR).map((g) => g.verbTense);

export const MONTH_NAMES_PT = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro',
];
