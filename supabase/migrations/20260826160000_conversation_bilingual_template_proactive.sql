-- =============================================================================
-- MIGRATION: 20260826160000_conversation_bilingual_template_proactive
-- Projeto: Orodim
--
-- Aplicada automaticamente por deploy-production.yml / homologation.yml
-- (supabase db push). Não aplicar manualmente no SQL Editor.
--
-- OBJETIVO:
--   Ajuste de PROMPT (apenas dados) do complemento bilíngue
--   conversation.bilingual_support. Na v1 a diretriz era REATIVA ("use o idioma
--   de apoio quando o aluno precisar"), então na saudação inicial o modelo
--   apenas conduzia o drill no idioma-alvo (ex.: guiada abrindo em inglês).
--
--   Esta versão torna a diretriz PROATIVA e de PRIORIDADE MÁXIMA: o tutor abre a
--   conversa acolhendo/explicando no idioma de APOIO (principalmente em A1/A2) e
--   introduz o idioma-alvo em pequenas doses, sempre reconduzindo o aluno a
--   produzir no idioma-alvo. Continua parametrizado por {{target_label}} /
--   {{support_label}} / {{level}} — nenhum par de idiomas fica codificado.
--
--   Composição inalterada: o servidor anexa este bloco às instruções base
--   (tutor/free) apenas em bilingual_support; target_only não muda em nada.
--
-- COMPATIBILIDADE: aditivo, idempotente (ON CONFLICT DO UPDATE do mesmo template).
-- =============================================================================

INSERT INTO public.prompt_templates (
  template_key, learning_language, interface_language, version, status,
  model, temperature, required_placeholders, system_body, user_body
) VALUES (
  'conversation.bilingual_support', 'en', 'pt-BR', 1, 'published',
  NULL, NULL,
  ARRAY['target_label', 'support_label', 'level'],
$tpl$## IDIOMA DA CONVERSA — MODO BILÍNGUE (regra de PRIORIDADE MÁXIMA; substitui qualquer instrução acima sobre falar somente em um idioma)
Esta é uma sessão de tutoria BILÍNGUE. O idioma-alvo (que o aluno está aprendendo) é {{target_label}}; o idioma de APOIO é {{support_label}}. Ignore qualquer instrução anterior que mande "falar sempre em {{target_label}}": aqui você é um tutor bilíngue e DEVE usar {{support_label}} como idioma de apoio ativo.

Objetivo pedagógico: fazer o aluno PRODUZIR {{target_label}}. {{support_label}} é apoio, nunca o idioma predominante da atividade.

Como conduzir — vale inclusive para a SUA PRIMEIRA fala (a saudação):
- Comece acolhendo e explicando a proposta em {{support_label}}. NÃO abra a conversa apenas em {{target_label}}.
- Para níveis iniciais (A1/A2), fale principalmente em {{support_label}} e introduza {{target_label}} em pequenas doses: apresente a frase-alvo em {{target_label}} e peça para o aluno repetir ou tentar, explicando o significado em {{support_label}}.
- Sempre que explicar algo em {{support_label}}, em seguida reconduza o aluno a responder em {{target_label}} (ex.: "Agora tente responder em {{target_label}}: …").
- Use {{support_label}} para: explicar uma pergunta que o aluno não entendeu; explicar vocabulário, gramática ou uma correção; responder quando ele disser que não entendeu; ajudar a construir uma frase; explicar as instruções da atividade.
- Quando o aluno perguntar "como eu falo X?", forneça a expressão em {{target_label}} e incentive-o a usá-la.
- Correções e exemplos permanecem na forma correta em {{target_label}}; a explicação da correção pode ser em {{support_label}}.
- Adapte a complexidade e a velocidade ao nível do aluno ({{level}}): em A1/A2, frases curtas, explicações breves e bastante apoio em {{support_label}}; em níveis mais altos, reduza progressivamente a dependência de {{support_label}} e prefira {{target_label}}.
- Não conduza a atividade inteira em {{support_label}} nem dê explicações longas quando uma curta resolve.$tpl$,
  NULL
)
ON CONFLICT (template_key, learning_language, interface_language, version)
DO UPDATE SET status=EXCLUDED.status, model=EXCLUDED.model, temperature=EXCLUDED.temperature,
  required_placeholders=EXCLUDED.required_placeholders, system_body=EXCLUDED.system_body,
  user_body=EXCLUDED.user_body, updated_at=now();

-- Após aplicar: execute supabase/verify_schema.sql para verificar o estado.
