-- =============================================================================
-- MIGRATION: 20260812160000_add_version_2_final_text_to_reviews
-- Projeto: Orodim
--
-- Aplicada automaticamente por .github/workflows/deploy-production.yml
-- (supabase db push) após o merge na main, e por
-- .github/workflows/homologation.yml após push em develop. Não aplicar
-- manualmente no SQL Editor — isso desalinha o histórico de
-- `supabase migration list`.
-- Esta migration NÃO modifica nem remove dados existentes.
--
-- OBJETIVO: adicionar a coluna english_reviews.version_2_final_text, usada
-- para persistir a versão final corrigida pela IA da segunda versão do aluno
-- ("revisão/versão final"). A coluna já era referenciada pelo código
-- (api/compare-rewrite.ts, src/lib/reviews.ts, src/components/RewriteSection.tsx),
-- mas a migration original que a adicionava
-- (supabase/migrations_legacy/20260715100000_add_v2_final_text_to_reviews.sql)
-- ficou ANTERIOR ao corte de baseline (20260725120000) e nunca foi aplicada a
-- produção — só as colunas irmãs version_2_text / version_2_comparison /
-- version_2_improvement_score foram. Como o baseline foi capturado por
-- introspecção de produção, a coluna também não existe em homologação. Sem ela,
-- a geração da IA funcionava mas TODO save da versão final falhava com
-- 42703 "column version_2_final_text does not exist", exibindo ao aluno
-- "A versão final foi gerada, mas não foi possível salvá-la. Tente novamente."
--
-- ESCOPO: puramente aditivo (uma coluna nova, nullable). Não altera RLS,
-- policies, grants nem dados. As policies er_select/er_update existentes já
-- cobrem a nova coluna (são a nível de linha, não de coluna).
-- =============================================================================

ALTER TABLE public.english_reviews
  ADD COLUMN IF NOT EXISTS version_2_final_text TEXT;

-- Após aplicar: execute supabase/verify_schema.sql para verificar o estado.
