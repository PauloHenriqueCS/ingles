-- =============================================================================
-- MIGRATION: 20260717130000_migrate_legacy_teacher_name
-- Projeto: Lemon
--
-- APLICAR UMA ÚNICA VEZ no Supabase SQL Editor.
-- Esta migration NÃO remove dados existentes — apenas corrige um valor.
-- =============================================================================

-- A identidade da assistente é fixa e não configurável: é sempre "Lemon"
-- (ver src/lib/tutorPreferences.ts ASSISTANT_NAME). O código da aplicação não
-- confia mais em ai_conversation_preferences.teacher_name para a identidade,
-- mas linhas criadas antes da renomeação do app (Alex -> Lemon AI -> Lemon)
-- ainda podem conter um valor antigo. Corrige o dado armazenado para refletir
-- a realidade. Idempotente: só afeta linhas que ainda não dizem 'Lemon'.

UPDATE public.ai_conversation_preferences
SET teacher_name = 'Lemon'
WHERE teacher_name IS DISTINCT FROM 'Lemon';

-- Após aplicar: execute supabase/verify_schema.sql para verificar o estado.
