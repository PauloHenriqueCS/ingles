-- =============================================================================
-- MIGRATION: 20260801130000_migrate_teacher_name_lemon_to_orodim
-- Projeto: Orodim (rebrand de Lemon)
--
-- Aplicada automaticamente por .github/workflows/deploy-production.yml
-- (supabase db push) após o merge na main. Não aplicar manualmente no SQL
-- Editor — isso desalinha o histórico de `supabase migration list`.
-- Esta migration NÃO modifica nem remove dados de usuário — apenas corrige
-- o valor de identidade fixa da assistente e o default da coluna.
-- =============================================================================

-- A identidade da assistente é fixa e não configurável pelo usuário: era
-- "Lemon" e passa a ser "Orodim" (ver src/lib/tutorPreferences.ts
-- ASSISTANT_NAME, única fonte de verdade — o código nunca confia no valor
-- armazenado em teacher_name para montar o system prompt; ver também
-- rowToPrefs() em src/hooks/useTutorPreferences.ts e api/conversation/[...slug].ts,
-- que já fazem "self-heal" de valores desatualizados). Esta migration só
-- alinha o dado persistido e o default da coluna à nova identidade, seguindo
-- o mesmo padrão da migration legada
-- supabase/migrations_legacy/20260717130000_migrate_legacy_teacher_name.sql
-- (que fez a mesma correção pontual na transição Alex -> Lemon).
--
-- Escopo: coluna public.ai_conversation_preferences.teacher_name apenas.
-- Não afeta nenhuma outra tabela, histórico de conversas, mensagens de
-- usuário ou conteúdo pedagógico. Não cria tabela nem coluna nova.

-- 1) Corrige linhas existentes (idempotente: só afeta linhas que ainda não
--    dizem 'Orodim'). Em produção, no momento em que este arquivo foi
--    escrito, isso afeta exatamente 1 linha (teacher_name = 'Lemon').
UPDATE public.ai_conversation_preferences
SET teacher_name = 'Orodim'
WHERE teacher_name IS DISTINCT FROM 'Orodim';

-- 2) Atualiza o default da coluna para novos registros. O default anterior
--    ('Alex') já estava obsoleto antes desta migration e nunca era confiado
--    pelo código da aplicação (todo INSERT/UPSERT vindo do app já envia
--    teacher_name = ASSISTANT_NAME explicitamente); ainda assim, alinhamos
--    o default ao valor atual da identidade.
ALTER TABLE public.ai_conversation_preferences
  ALTER COLUMN teacher_name SET DEFAULT 'Orodim';

-- Após aplicar: execute supabase/verify_schema.sql e confirme:
--   SELECT teacher_name, count(*) FROM public.ai_conversation_preferences GROUP BY 1;
-- deve retornar uma única linha: ('Orodim', <n>).
