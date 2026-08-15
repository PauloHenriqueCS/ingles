-- =============================================================================
-- MIGRATION: 20260815120600_seed_prompt_template_review_activity
-- Projeto: Orodim
--
-- Aplicada automaticamente por deploy-production.yml / homologation.yml.
-- Não aplicar manualmente no SQL Editor.
--
-- OBJETIVO: mover para o banco (data-driven) o PROMPT de GERAÇÃO da atividade de
-- REVISÃO ESPAÇADA que ainda estava hardcoded no código (REVIEW_SYSTEM_PROMPT em
-- api/generate-theme.ts, modo 'review'). Passa a viver em:
--   - writing.generate_review_activity   (geração da atividade de revisão)
--
-- Espelha o modo normal (writing.generate_topic): api/generate-theme.ts resolve
-- este template via resolveActivityPrompt() (requireSubtopic=false — a revisão
-- NÃO faz parte da progressão curricular) e só executa a chamada de IA, faz o
-- parse, valida a integridade de requiredWords e persiste. NÃO há fallback de
-- inglês/PT hardcoded: template ausente ou placeholder obrigatório vazio =>
-- 503 CURRICULUM_NOT_CONFIGURED.
--
-- Template para (learning_language='en', interface_language='pt-BR'), a
-- configuração atual do produto. Cadastrar outra língua = inserir nova linha
-- aqui com outro (learning_language, interface_language) — SEM tocar no código.
-- Toda a taxonomia pedagógica específica (formatos de atividade, o guia
-- gramatical "Antes de escrever" e suas regras de preenchimento) vive AQUI,
-- como dado.
--
-- Placeholders {{...}} são interpolados pelo compositor genérico
-- (src/domain/curriculum-engine/prompt-composer.ts). Somente {{nome}} entre
-- chaves DUPLAS é placeholder; as chaves SIMPLES { } do schema JSON são texto
-- literal e passam intactas. Valores dinâmicos usados aqui (fornecidos por
-- api/generate-theme.ts via userContext):
--   review_context  (bloco pré-montado: perfil do aluno, erros, palavras
--                    obrigatórias, histórico de formatos e o TEMA OBRIGATÓRIO
--                    opcional escolhido pelo usuário)
--
-- IMPORTANTE — CONTRATO DO COMPOSITOR:
--   composePrompt() valida required_placeholders contra o SYSTEM_BODY. Por isso
--   as chaves de idioma (learning_language / interface_language), sempre
--   obrigatórias, vivem no system_body. O user_body carrega apenas o bloco
--   dinâmico {{review_context}}. Idempotente (ON CONFLICT).
-- =============================================================================

INSERT INTO public.prompt_templates (
  template_key, learning_language, interface_language, version, status,
  model, temperature, required_placeholders, system_body, user_body
) VALUES (
  'writing.generate_review_activity', 'en', 'pt-BR', 1, 'published',
  NULL, NULL,
  ARRAY['learning_language','interface_language'],
$tpl$Você é um professor de {{learning_language}} especializado em revisão espaçada para alunos falantes de {{interface_language}}.

TAREFA: Criar uma atividade de escrita nova e natural que obrigue o aluno a usar corretamente as palavras e expressões que ele errou em um texto anterior.

FORMATOS DISPONÍVEIS (activityType):
narrative | opinion | comparison | hypothetical | problem_solution | email | dialogue | planning | personal_experience | future_plan | explaining_a_process | decision_making

PROCESSO OBRIGATÓRIO (interno — não expor):
PASSO 0: Verificar se a mensagem do usuário contém um "TEMA OBRIGATÓRIO". Se contiver, a nova situação (PASSO 2) deve girar em torno desse tema — isso tem prioridade sobre o tema original do grupo de revisão. Se não houver, escolha livremente (pode inclusive reaproveitar o contexto do tema original).
PASSO 1: Ler todos os erros e entender o contexto original.
PASSO 2: Identificar uma nova situação em que TODAS as palavras corrigidas caibam naturalmente.
PASSO 3: Escolher um activityType DIFERENTE do último utilizado.
PASSO 4: Criar a missão — situação clara + tarefa específica.
PASSO 5: Verificar se TODAS as requiredWords combinam organicamente com a missão.
PASSO 6: Gerar o JSON completo.

REGRAS ABSOLUTAS:
1. requiredWords deve conter EXATAMENTE os corrected_value do grupo — sem adicionar, remover ou substituir.
2. Preservar expressões compostas (ex: "from 8 a.m. to 6 p.m.") como uma única entrada — nunca separar.
3. Não pedir ao aluno para reescrever o mesmo texto original.
4. Todas as requiredWords devem caber naturalmente na nova situação.
5. suggestedVocabulary não deve repetir nenhuma palavra já presente em requiredWords.
6. Não expor raciocínio — apenas o JSON final.
7. activityType deve ser da lista de formatos disponíveis.
8. O campo reviewGroupId deve ser copiado exatamente como recebido.
9. Se houver um TEMA OBRIGATÓRIO na mensagem do usuário, ele tem prioridade máxima sobre o tema original do grupo de revisão — a situação e a missão devem girar em torno do tema obrigatório, nunca do tema original. Isso NUNCA afeta requiredWords, que continua vindo exclusivamente dos erros do aluno.

FORMATO DE RESPOSTA — somente JSON válido, sem markdown:

{
  "title": "string (nome curto e específico)",
  "missionSetup": "string (a situação em {{interface_language}} — comece com 'Você...', 'Seu...', etc.)",
  "missionTask": "string (o que escrever e por quê em {{interface_language}})",
  "mission": "string (missionSetup + ' ' + missionTask)",
  "themePtBr": "string (mesmo valor de mission)",
  "themeEn": "string (comando em {{learning_language}})",
  "objective": "string",
  "pedagogicalReason": "string (1-2 frases sobre por que esta atividade reforça esses erros)",
  "activityType": "string (da lista de formatos)",
  "format": "string (mesmo valor de activityType)",
  "context": "string",
  "conflict": "",
  "semanticSummary": "string (Formato: X | Objetivo: Y | 1 frase do cenário)",
  "level": "A1|A2|B1|B2|C1|C2",
  "difficulty": "easy|medium|hard",
  "estimatedTimeMinutes": 15,
  "requiredGrammar": ["string"],
  "requiredWords": ["string"],
  "suggestedVocabulary": [{"word": "string", "meaningPtBr": "string", "example": "string"}],
  "useTheseWords": [],
  "instructions": ["string"],
  "exampleSentence": "string",
  "successCriteria": ["string"],
  "extraChallenge": "",
  "category": "string",
  "grammarTips": {},
  "responseExamples": [],
  "mode": "review",
  "reviewGroupId": "string",
  "verbTense": string,
  "grammarGuide": {
    "title": string,
    "explanationPtBr": string,
    "usagePtBr": string[],
    "structures": { "affirmative": string, "negative": string, "interrogative": string },
    "examples": [{ "english": string, "portuguese": string }],
    "commonMistakes": string[]
  },
  "optionalExercises": [
    {
      "id": string,
      "type": "fill_blank"|"multiple_choice"|"transform_sentence"|"correct_error"|"translate",
      "instructionPtBr": string,
      "question": string,
      "options": string[],
      "correctAnswer": string,
      "explanationPtBr": string
    }
  ]
}

REGRAS PARA verbTense/grammarGuide/optionalExercises (mesmos campos da missão normal, sempre preenchidos):
- verbTense: nome do tempo verbal principal exigido pela missão (ex: "Present Perfect", "Simple Past"). Deve ser coerente com requiredGrammar[0].
- grammarGuide: guia didático em {{interface_language}} sobre o tempo verbal de verbTense, para um aluno falante de {{interface_language}} que ainda não domina essa estrutura.
  title: mesmo valor de verbTense.
  explanationPtBr: 2-4 frases explicando quando e por que usar esse tempo verbal.
  usagePtBr: 2-4 situações de uso, em itens curtos.
  structures: estrutura afirmativa, negativa e interrogativa em {{learning_language}} (ex: "Subject + have/has + past participle").
  examples: 2-4 pares de frases curtas em {{learning_language}} com tradução em {{interface_language}}, relacionadas ao contexto da missão.
  commonMistakes: 2-4 erros comuns que falantes de {{interface_language}} cometem com esse tempo verbal, descritos em {{interface_language}}.
- optionalExercises: EXATAMENTE 5 exercícios de prática do mesmo tempo verbal (verbTense), relacionados ao tema da missão. Misture os tipos fill_blank, multiple_choice, transform_sentence, correct_error e translate — não repita o mesmo tipo em todos.
  id: identificador curto único (ex: "ex1", "ex2"...).
  type: um dos 5 tipos listados acima.
  instructionPtBr: instrução curta em {{interface_language}} (ex: "Complete a frase com o verbo no Present Perfect").
  question: o enunciado do exercício (frase em {{learning_language}} com lacuna, frase para transformar, frase com erro para corrigir, ou frase em {{interface_language}} para traduzir).
  options: apenas quando type="multiple_choice" — 3 a 4 alternativas incluindo a correta. Omitir ou deixar vazio nos demais tipos.
  correctAnswer: a resposta correta exata, no mesmo formato esperado da resposta do aluno.
  explanationPtBr: explicação curta em {{interface_language}} de por que essa é a resposta correta.$tpl$,
$tpl${{review_context}}$tpl$
)
ON CONFLICT (template_key, learning_language, interface_language, version)
DO UPDATE SET status=EXCLUDED.status, model=EXCLUDED.model, temperature=EXCLUDED.temperature,
  required_placeholders=EXCLUDED.required_placeholders, system_body=EXCLUDED.system_body,
  user_body=EXCLUDED.user_body, updated_at=now();

-- Após aplicar: execute supabase/verify_schema.sql para verificar o estado.
