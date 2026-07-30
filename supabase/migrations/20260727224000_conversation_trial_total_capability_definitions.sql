-- =============================================================================
-- MIGRATION: 20260727224000_conversation_trial_total_capability_definitions
-- Projeto: Lemon
--
-- Histórico de renomeações (Etapa 2A — revisão de versionamento), nenhuma
-- delas aplicada em nenhum ambiente:
--   20260727000000 → colidia literalmente com o nome de arquivo de uma
--     migration do repositório ingles-dashboad
--     (20260727000000_trial_plan_and_capability_reconciliation.sql), já
--     aplicada em lemon-homolog sob a versão real 20260727223126
--     (confirmado via list_migrations em modo leitura — a versão registrada
--     em supabase_migrations.schema_migrations é o horário real de
--     aplicação, não necessariamente o timestamp do nome do arquivo).
--   20260728000000 → data artificialmente no futuro (hoje é 27/07/2026, não
--     28/07/2026) — corrigida para 20260727224000, a mesma data de hoje,
--     posterior à maior versão remota conhecida (20260727223126),
--     reverificada em modo leitura imediatamente antes desta renomeação
--     (nenhuma migration nova apareceu em nenhum dos dois repositórios nem
--     em lemon-homolog desde a rodada anterior).
--
-- Reconciliação revisada (não é mais ON CONFLICT DO UPDATE):
--
-- Auditoria confirmada por leitura de código (nenhuma escrita): NENHUM
-- caminho de execução deste app (`ingles`) — plan-entitlements-service.ts,
-- api/_ai-gateway/entitlements.ts, resolve-capability-values.ts — jamais
-- consulta a tabela capability_definitions em tempo de execução. O único
-- contrato real que este app exige dela é a FK
-- plan_capability_values.capability_key -> capability_definitions.key: a
-- LINHA precisa existir para que plan_capability_values possa referenciá-la.
-- category/label/description/help_text/value_type/unit/default_period/
-- allowed_periods/default_value/constraints/dependency_key/
-- is_plan_configurable/active/source_reference/display_order são consumidos
-- apenas pela UI/validador administrativos do ingles-dashboad — nunca lidos
-- por este app. Não existe, portanto, nenhum "campo tecnicamente
-- indispensável" que justifique sobrescrever uma linha já existente.
--
-- Confirmado por leitura em lemon-homolog (list_migrations + SELECT ... FROM
-- capability_definitions, modo leitura, nenhuma escrita): o ingles-dashboad
-- já aplicou 20260727223126, que já criou as duas linhas abaixo com valores
-- tecnicamente corretos e coerentes (value_type/default_period/active/
-- is_plan_configurable) — não há hoje nenhuma incompatibilidade técnica a
-- corrigir. Por isso a reconciliação é estritamente:
--
--   INSERT ... ON CONFLICT (key) DO NOTHING
--
-- — nunca sobrescreve label/description/display_order/constraints/
-- allowed_periods/dependency_key/nem qualquer outro campo de uma linha já
-- existente, seja ela criada pelo ingles-dashboad, por este arquivo em outro
-- ambiente, ou manualmente. Só insere quando a chave está genuinamente
-- ausente (ex.: um ambiente onde a migration do ingles-dashboad nunca
-- rodou) — com valores espelhando exatamente os que o ingles-dashboad já
-- gravou em lemon-homolog, para que o resultado seja idêntico
-- independentemente de qual dos dois repositórios rodar primeiro.
--
-- Nunca renomeia nem altera nenhuma capability diferente destas duas.
-- =============================================================================

INSERT INTO public.capability_definitions (
  key, category, group_key, label, description, help_text, value_type, unit,
  default_period, allowed_periods, default_value, constraints, dependency_key,
  is_plan_configurable, active, source_reference, display_order
) VALUES (
  'conversation.realtime.seconds.trial_total',
  'quota',
  'conversation',
  'Segundos de conversação (total do trial)',
  'Total de segundos de conversa em tempo real permitido durante toda a atribuição de trial (não é um limite mensal)',
  NULL,
  'integer',
  'seconds',
  'lifetime',
  '["lifetime"]',
  '0',
  '{"min":0}',
  'conversation.enabled',
  TRUE,
  TRUE,
  NULL,
  320
) ON CONFLICT (key) DO NOTHING;

INSERT INTO public.capability_definitions (
  key, category, group_key, label, description, help_text, value_type, unit,
  default_period, allowed_periods, default_value, constraints, dependency_key,
  is_plan_configurable, active, source_reference, display_order
) VALUES (
  'conversation.realtime.seconds.trial_total.unlimited',
  'quota',
  'conversation',
  'Segundos de conversação (total do trial) — ilimitado',
  'Indica se o total de segundos de conversação do teste gratuito é ilimitado. Segue o mesmo padrão pareado das demais flags `.unlimited` do catálogo.',
  NULL,
  'boolean',
  'enabled',
  'none',
  '["none"]',
  'false',
  '{}',
  'conversation.enabled',
  TRUE,
  TRUE,
  NULL,
  324
) ON CONFLICT (key) DO NOTHING;
