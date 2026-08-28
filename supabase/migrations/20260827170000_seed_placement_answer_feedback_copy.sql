-- =============================================================================
-- MIGRATION: 20260827120000_seed_placement_answer_feedback_copy
-- Projeto: Orodim
--
-- Aplicada automaticamente por deploy-production.yml / homologation.yml
-- (supabase db push --include-all). NÃO aplicar manualmente no SQL Editor.
--
-- OBJETIVO: semear a copy (pt-BR) do FEEDBACK por questão do teste de nível.
-- Após cada resposta objetiva, o app mostra se o usuário acertou/errou e qual é
-- a alternativa correta (o gabarito continua PRIVADO até o envio da resposta).
-- Estes textos são apenas rótulos de UI; há fallbacks equivalentes no cliente
-- (PlacementOnboarding.tsx), então a migração é opcional para funcionar, mas
-- mantém a copy data-driven/traduzível como o restante de placement_ui_copy.
--
-- Idempotente (ON CONFLICT DO NOTHING). Depende de
-- 20260815130100_seed_placement_english_v1.sql (teste 'english-placement').
-- =============================================================================

INSERT INTO public.placement_ui_copy (placement_test_id, interface_language, copy_key, body)
SELECT t.id, 'pt-BR', v.copy_key, v.body
FROM public.placement_tests t
CROSS JOIN (VALUES
  ('feedback_correct_title',   'Você acertou!'),
  ('feedback_incorrect_title', 'Resposta incorreta'),
  ('feedback_correct_label',   'Resposta correta'),
  ('cta_continue',             'Continuar')
) AS v(copy_key, body)
WHERE t.slug = 'english-placement'
ON CONFLICT (placement_test_id, interface_language, copy_key) DO NOTHING;
