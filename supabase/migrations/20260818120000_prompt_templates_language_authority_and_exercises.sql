-- =============================================================================
-- MIGRATION: 20260818120000_prompt_templates_language_authority_and_exercises
-- Projeto: Orodim
--
-- Aplicada automaticamente por deploy-production.yml / homologation.yml.
-- Não aplicar manualmente no SQL Editor.
--
-- OBJETIVO (corrige uma regressão SISTÊMICA de resolução de idioma):
--
--   Os templates data-driven usavam {{learning_language}} / {{interface_language}}
--   como diretriz de idioma de SAÍDA. O compositor interpola esses placeholders
--   com o CÓDIGO ISO cru ("en", "pt-BR"). "Escreva a história in en" é um sinal
--   fraco e ambíguo; somado a metadados do currículo injetados no idioma da
--   interface (ex.: a capacidade "Cumprimentar e apresentar-se" e os alvos
--   "saudações, pronomes pessoais" em pt-BR) e a "explicações em pt-BR", o modelo
--   DERIVA e gera a história / a correção no idioma ERRADO (pt-BR) — foi exatamente
--   o que ocorreu em Listening e na "Versão final corrigida" da Escrita.
--
--   O idioma pedagógico da atividade (learning language) deve ser AUTORIDADE da
--   saída. A correção é 100% data-driven e multilíngue: o compositor agora expõe
--   NOMES legíveis de idioma vindos de public.languages
--   ({{learning_language_name}} = "English", {{interface_language_name}} =
--   "Brazilian Portuguese"), injetados por api/_curriculum/curriculum-runtime.ts
--   → resolveActivityPrompt. Esta migration:
--
--     1. Troca, de forma cirúrgica, {{learning_language}}→{{learning_language_name}}
--        e {{interface_language}}→{{interface_language_name}} no corpo e nos
--        required_placeholders dos templates (preservando toda a redação
--        pedagógica já ajustada — NÃO reescreve os corpos).
--     2. Acrescenta uma REGRA DE IDIOMA DA SAÍDA explícita e inegociável aos
--        templates que produzem texto do aluno no learning language
--        (listening, pronúncia, tutor de conversa e as correções de escrita).
--     3. Re-cria (upsert) writing.generate_topic incluindo de volta o guia
--        gramatical + os exercícios preparatórios ("Antes de escrever"), que
--        haviam sumido quando o contrato estrito parou de pedi-los.
--
-- Idempotente: os replaces não têm efeito quando o token novo já está presente
-- (o token antigo deixa de ser substring do novo); a REGRA só é acrescentada
-- quando o marcador ainda não existe no corpo; os upserts usam ON CONFLICT.
-- =============================================================================

-- ── 1+2) Troca de placeholders (código → NOME) + REGRA DE IDIOMA DA SAÍDA ──────
--
-- Nenhuma pedagogia específica de idioma no código: a REGRA nomeia a língua via
-- os mesmos placeholders {{learning_language_name}}/{{interface_language_name}}
-- resolvidos por dado (public.languages) para QUALQUER par de idiomas.

-- Helper conceptual repetido inline por template para manter a migration explícita
-- e revisável. Cada UPDATE: (a) troca os placeholders no corpo; (b) troca nos
-- required_placeholders; (c) acrescenta a REGRA se ainda não houver marcador.

-- Listening: história em learning language (voz é multilíngue e fala fielmente o
-- que estiver no texto — por isso o áudio saía em pt-BR quando o texto saía errado).
UPDATE public.prompt_templates SET
  system_body = replace(replace(system_body, '{{learning_language}}', '{{learning_language_name}}'), '{{interface_language}}', '{{interface_language_name}}')
    || CASE WHEN position('=== OUTPUT LANGUAGE (NON-NEGOTIABLE) ===' in system_body) = 0 THEN
$g$

=== OUTPUT LANGUAGE (NON-NEGOTIABLE) ===
Write the STORY itself — its title, its summary, and the text of BOTH parts — entirely and only in {{learning_language_name}}. NEVER write the story in {{interface_language_name}} or any other language, even though these instructions and the target-capability descriptions above are written in {{interface_language_name}}. The ONLY {{interface_language_name}} text allowed is inside each comprehension question's explanation. If you are about to write the story in {{interface_language_name}}, stop and write it in {{learning_language_name}} instead.$g$ ELSE '' END,
  user_body = replace(replace(coalesce(user_body,''), '{{learning_language}}', '{{learning_language_name}}'), '{{interface_language}}', '{{interface_language_name}}'),
  required_placeholders = array_replace(array_replace(required_placeholders, 'learning_language', 'learning_language_name'), 'interface_language', 'interface_language_name'),
  updated_at = now()
WHERE template_key = 'listening.two_part_generate';

-- Pronúncia: texto lido em voz alta, no learning language.
UPDATE public.prompt_templates SET
  system_body = replace(replace(system_body, '{{learning_language}}', '{{learning_language_name}}'), '{{interface_language}}', '{{interface_language_name}}')
    || CASE WHEN position('=== OUTPUT LANGUAGE (NON-NEGOTIABLE) ===' in system_body) = 0 THEN
$g$

=== OUTPUT LANGUAGE (NON-NEGOTIABLE) ===
Output the practice text entirely and only in {{learning_language_name}}. NEVER output {{interface_language_name}} or a translation, even though these instructions may reference {{interface_language_name}}.$g$ ELSE '' END,
  user_body = replace(replace(coalesce(user_body,''), '{{learning_language}}', '{{learning_language_name}}'), '{{interface_language}}', '{{interface_language_name}}'),
  required_placeholders = array_replace(array_replace(required_placeholders, 'learning_language', 'learning_language_name'), 'interface_language', 'interface_language_name'),
  updated_at = now()
WHERE template_key = 'pronunciation.generate_text';

-- Tutor de conversa (guiada): fala com o aluno no learning language.
UPDATE public.prompt_templates SET
  system_body = replace(replace(system_body, '{{learning_language}}', '{{learning_language_name}}'), '{{interface_language}}', '{{interface_language_name}}')
    || CASE WHEN position('=== OUTPUT LANGUAGE (NON-NEGOTIABLE) ===' in system_body) = 0 THEN
$g$

=== OUTPUT LANGUAGE (NON-NEGOTIABLE) ===
Speak to the learner only in {{learning_language_name}}. Only brief correction explanations may use {{interface_language_name}}. Never switch the conversation itself to {{interface_language_name}}.$g$ ELSE '' END,
  user_body = replace(replace(coalesce(user_body,''), '{{learning_language}}', '{{learning_language_name}}'), '{{interface_language}}', '{{interface_language_name}}'),
  required_placeholders = array_replace(array_replace(required_placeholders, 'learning_language', 'learning_language_name'), 'interface_language', 'interface_language_name'),
  updated_at = now()
WHERE template_key = 'conversation.tutor';

-- Correção da escrita (primeira revisão): a saída é JSON em interface language,
-- MAS o campo correctedText (e exemplos/trechos corrigidos) fica no learning
-- language. A REGRA é escrita no idioma do template (pt-BR) e casa com a linha row.
UPDATE public.prompt_templates SET
  system_body = replace(replace(system_body, '{{learning_language}}', '{{learning_language_name}}'), '{{interface_language}}', '{{interface_language_name}}')
    || CASE WHEN position('=== IDIOMA DA SAÍDA (INEGOCIÁVEL) ===' in system_body) = 0 THEN
$g$

=== IDIOMA DA SAÍDA (INEGOCIÁVEL) ===
Os campos correctedText, usedExcerpt, suggestedCorrection e quaisquer exemplos ou trechos corrigidos devem permanecer inteiramente em {{learning_language_name}} — a MESMA língua em que o aluno escreveu. NUNCA traduza o texto corrigido para {{interface_language_name}} nem misture os dois idiomas. Apenas as explicações, os comentários e o resumo usam {{interface_language_name}}. Se o texto do aluno contiver algum trecho em {{interface_language_name}}, corrija-o para {{learning_language_name}} em vez de mantê-lo.$g$ ELSE '' END,
  user_body = replace(replace(coalesce(user_body,''), '{{learning_language}}', '{{learning_language_name}}'), '{{interface_language}}', '{{interface_language_name}}'),
  required_placeholders = array_replace(array_replace(required_placeholders, 'learning_language', 'learning_language_name'), 'interface_language', 'interface_language_name'),
  updated_at = now()
WHERE template_key IN ('writing.correct', 'writing.correct_review');

-- "Versão final corrigida" (writing.correct_v2_text): a saída É apenas o texto
-- corrigido, no learning language. Este é o bug reportado (saída híbrida pt/en).
UPDATE public.prompt_templates SET
  system_body = replace(replace(system_body, '{{learning_language}}', '{{learning_language_name}}'), '{{interface_language}}', '{{interface_language_name}}')
    || CASE WHEN position('=== OUTPUT LANGUAGE (NON-NEGOTIABLE) ===' in system_body) = 0 THEN
$g$

=== OUTPUT LANGUAGE (NON-NEGOTIABLE) ===
The corrected text you output must be entirely and only in {{learning_language_name}} — the same language the student wrote in. NEVER translate any part of it into {{interface_language_name}} and NEVER mix the two languages. If the reference correction above contains any {{interface_language_name}}, treat that as an error and write that part in {{learning_language_name}}.$g$ ELSE '' END,
  user_body = replace(replace(coalesce(user_body,''), '{{learning_language}}', '{{learning_language_name}}'), '{{interface_language}}', '{{interface_language_name}}'),
  required_placeholders = array_replace(array_replace(required_placeholders, 'learning_language', 'learning_language_name'), 'interface_language', 'interface_language_name'),
  updated_at = now()
WHERE template_key = 'writing.correct_v2_text';

-- Comparação/avaliação do rewrite: a saída PRINCIPAL é JSON no interface language
-- (com pequenos exemplos no learning language). Aqui NÃO cabe uma regra "escreva
-- tudo no learning language" — apenas trocamos os placeholders para o NOME, para
-- que "exemplos em {{learning_language_name}}" fique inequívoco.
UPDATE public.prompt_templates SET
  system_body = replace(replace(system_body, '{{learning_language}}', '{{learning_language_name}}'), '{{interface_language}}', '{{interface_language_name}}'),
  user_body = replace(replace(coalesce(user_body,''), '{{learning_language}}', '{{learning_language_name}}'), '{{interface_language}}', '{{interface_language_name}}'),
  required_placeholders = array_replace(array_replace(required_placeholders, 'learning_language', 'learning_language_name'), 'interface_language', 'interface_language_name'),
  updated_at = now()
WHERE template_key IN ('writing.compare_rewrite', 'writing.evaluate_rewrite');

-- ── 3) writing.generate_topic: restaura guia gramatical + exercícios preparatórios
--
-- Estes voltam a ser pedidos NO MESMO call da missão (o frontend já os lê de
-- theme.grammarGuide / theme.optionalExercises via normalizeGrammarGuide /
-- normalizeOptionalExercises em api/_mission-grammar-guide.ts — nenhum exercício
-- hardcoded; reaproveita o mecanismo existente). Também troca os placeholders de
-- idioma para os NOMES legíveis. Idempotente (ON CONFLICT DO UPDATE).
INSERT INTO public.prompt_templates (
  template_key, learning_language, interface_language, version, status,
  model, temperature, required_placeholders, system_body, user_body
) VALUES (
  'writing.generate_topic', 'en', 'pt-BR', 1, 'published',
  NULL, 0.88,
  ARRAY['learning_language_name','level','subtopic_capability'],
$tpl$Você é um professor particular de {{learning_language_name}} para alunos cujo idioma de interface é {{interface_language_name}}.

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
  instructions) deve ser escrita em {{interface_language_name}}; o texto que o aluno
  vai PRODUZIR é em {{learning_language_name}}.

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
  "exampleSentence":      uma frase-exemplo em {{learning_language_name}},
  "extraChallenge":       desafio opcional adicional (string),
  "whyThisActivity":      1 frase explicando por que esta missão ajuda o aluno,
  "verbTense":            tempo(s)/estrutura(s) gramatical(is) em foco (string, pode ser vazio),
  "grammarGuide": {
    "title":              nome da estrutura gramatical em foco (igual a verbTense),
    "explanationPtBr":    2-4 frases, em {{interface_language_name}}, explicando quando e por que usar essa estrutura,
    "usagePtBr":          array de 2-4 situações de uso, itens curtos em {{interface_language_name}},
    "structures":         { "affirmative": string, "negative": string, "interrogative": string } — cada forma em {{learning_language_name}},
    "examples":           array de 2-4 objetos { "english": frase em {{learning_language_name}}, "portuguese": tradução em {{interface_language_name}} },
    "commonMistakes":     array de 2-4 erros comuns, descritos em {{interface_language_name}}
  },
  "optionalExercises": [
    {
      "id":               identificador curto único (ex.: "ex1"),
      "type":             um de "fill_blank" | "multiple_choice" | "transform_sentence" | "correct_error" | "translate",
      "instructionPtBr":  instrução curta em {{interface_language_name}},
      "question":         enunciado do exercício (frase em {{learning_language_name}} com lacuna, para transformar/corrigir, ou frase em {{interface_language_name}} para traduzir),
      "options":          array de strings — apenas quando type="multiple_choice" (3-4 alternativas incluindo a correta); omitir nos demais,
      "correctAnswer":    resposta correta exata, no formato esperado da resposta do aluno,
      "explanationPtBr":  explicação curta em {{interface_language_name}} de por que essa é a resposta correta
    }
  ]
}

REGRAS DO CONTRATO (não negociáveis):
- title NÃO pode ser vazio nem genérico.
- missionSetup, missionTask e mission NÃO podem ser vazios; devem conter a
  instrução real da missão.
- difficulty deve ser exatamente um dos valores permitidos.
- estimatedTimeMinutes deve ser um número positivo.
- Os campos de array devem ser arrays (podem estar vazios apenas quando não se
  aplicarem), nunca null.
- grammarGuide: guia didático em {{interface_language_name}} sobre a estrutura de
  verbTense, para um aluno que ainda não a domina. Todo texto explicativo em
  {{interface_language_name}}; as estruturas e o lado esquerdo dos exemplos em
  {{learning_language_name}}.
- optionalExercises: EXATAMENTE 5 exercícios preparatórios da mesma estrutura
  (verbTense), relacionados ao tema da missão. Misture os tipos fill_blank,
  multiple_choice, transform_sentence, correct_error e translate — não repita o
  mesmo tipo em todos.
- Não invente campos fora do contrato.$tpl$,
  $tpl$Gere a missão de escrita agora, seguindo estritamente o contrato JSON, incluindo grammarGuide e os 5 optionalExercises.$tpl$
)
ON CONFLICT (template_key, learning_language, interface_language, version)
DO UPDATE SET status=EXCLUDED.status, model=EXCLUDED.model, temperature=EXCLUDED.temperature,
  required_placeholders=EXCLUDED.required_placeholders, system_body=EXCLUDED.system_body,
  user_body=EXCLUDED.user_body, updated_at=now();
