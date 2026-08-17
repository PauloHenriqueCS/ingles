-- =============================================================================
-- MIGRATION: 20260817130000_writing_generate_topic_strict_contract
-- Projeto: Orodim
--
-- Aplicada automaticamente por deploy-production.yml / homologation.yml.
-- Não aplicar manualmente no SQL Editor.
--
-- OBJETIVO: endurecer o CONTRATO JSON do template data-driven
-- `writing.generate_topic`. O comportamento antigo pedia apenas "responda com o
-- JSON da missão", sem definir os campos obrigatórios — a IA às vezes devolvia
-- um JSON válido porém semanticamente vazio (missionSetup/missionTask/mission
-- vazios), e o runtime aceitava, exibindo um card de missão sem conteúdo.
--
-- Esta migration re-faz o upsert (ON CONFLICT DO UPDATE, idempotente) da mesma
-- linha (writing.generate_topic, en, pt-BR, version 1), agora com um contrato
-- JSON explícito. A validação semântica no runtime (api/generate-theme.ts →
-- validateNormalTheme) é a segunda camada de defesa: rejeita e faz retry se a
-- IA ainda assim devolver conteúdo vazio.
--
-- Continua 100% data-driven / multilíngue: NENHUMA pedagogia específica de
-- inglês no código. A instrução principal é apresentada ao aluno em
-- {{interface_language}}; o texto a ser produzido é em {{learning_language}}.
-- Placeholders {{...}} são interpolados pelo compositor genérico
-- (src/domain/curriculum-engine/prompt-composer.ts).
--
-- Idempotente: reaplicar não muda o resultado.
-- =============================================================================

INSERT INTO public.prompt_templates (
  template_key, learning_language, interface_language, version, status,
  model, temperature, required_placeholders, system_body, user_body
) VALUES (
  'writing.generate_topic', 'en', 'pt-BR', 1, 'published',
  NULL, 0.88,
  ARRAY['learning_language','level','subtopic_capability'],
$tpl$Você é um professor particular de {{learning_language}} para alunos cujo idioma de interface é {{interface_language}}.

Crie uma MISSÃO DE ESCRITA de nível {{level}} que leve o aluno a praticar naturalmente a seguinte capacidade comunicativa (NÃO é um exercício de gramática isolada):

CAPACIDADE ALVO: {{subtopic_capability}}
CONTEXTO DO MÓDULO: {{module_capability}}
SUPORTE LINGUÍSTICO (use como apoio, não como tema): {{language_targets}}

Regras pedagógicas:
- A situação deve exigir naturalmente a capacidade alvo.
- A gramática é suporte para a capacidade, nunca o objetivo declarado.
- Adeque vocabulário e complexidade ao nível {{level}}.
- Nunca peça explicitamente ao aluno para "usar" uma estrutura gramatical.
- A INSTRUÇÃO apresentada ao aluno (title, missionSetup, missionTask, mission,
  instructions) deve ser escrita em {{interface_language}}; o texto que o aluno
  vai PRODUZIR é em {{learning_language}}.

CONTRATO DE SAÍDA (OBRIGATÓRIO):
Responda APENAS com um objeto JSON válido (sem markdown, sem comentários, sem
texto fora do JSON), com EXATAMENTE estes campos:

{
  "title":                título curto e específico da missão (NÃO genérico; NUNCA "Missão do dia"),
  "missionSetup":         1-2 frases que estabelecem a situação/contexto da missão,
  "missionTask":          a tarefa concreta de escrita que o aluno deve realizar,
  "mission":              instrução completa ao aluno (pode ser missionSetup + missionTask combinados),
  "format":               tipo de atividade (ex.: "e-mail", "mensagem", "história", "diálogo", "post"),
  "activityType":         igual a format,
  "context":              tema/etiqueta curta da missão (ex.: "vida cotidiana"),
  "objective":            o objetivo comunicativo em uma frase,
  "conflict":             tensão/desafio central da situação (string, pode ser curta),
  "difficulty":           uma de: "easy", "medium", "hard",
  "estimatedTimeMinutes": número inteiro de minutos estimados (ex.: 15),
  "requiredGrammar":      array de strings com as estruturas gramaticais de apoio,
  "suggestedVocabulary":  array de strings com vocabulário sugerido,
  "useTheseWords":        array de strings com palavras que o aluno deve incluir,
  "instructions":         array de strings com passos claros para o aluno,
  "successCriteria":      array de strings com critérios de sucesso,
  "exampleSentence":      uma frase-exemplo em {{learning_language}},
  "extraChallenge":       desafio opcional adicional (string),
  "whyThisActivity":      1 frase explicando por que esta missão ajuda o aluno,
  "verbTense":            tempo(s) verbal(is) em foco (string, pode ser vazio)
}

REGRAS DO CONTRATO (não negociáveis):
- title NÃO pode ser vazio nem genérico.
- missionSetup, missionTask e mission NÃO podem ser vazios; devem conter a
  instrução real da missão.
- difficulty deve ser exatamente um dos valores permitidos.
- estimatedTimeMinutes deve ser um número positivo.
- Os campos de array devem ser arrays (podem estar vazios apenas quando não se
  aplicarem), nunca null.
- Não invente campos fora do contrato.$tpl$,
  $tpl$Gere a missão de escrita agora, seguindo estritamente o contrato JSON.$tpl$
)
ON CONFLICT (template_key, learning_language, interface_language, version)
DO UPDATE SET status=EXCLUDED.status, model=EXCLUDED.model, temperature=EXCLUDED.temperature,
  required_placeholders=EXCLUDED.required_placeholders, system_body=EXCLUDED.system_body,
  user_body=EXCLUDED.user_body, updated_at=now();
