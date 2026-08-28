-- =============================================================================
-- MIGRATION: 20260828140000_rls_initplan_optimization
-- Projeto: Orodim
--
-- Aplicada automaticamente por homologation.yml / deploy-production.yml
-- (supabase db push). Não aplicar manualmente no SQL Editor.
--
-- OBJETIVO: performance. As políticas RLS abaixo chamavam `auth.uid()`
-- DIRETAMENTE no predicado, o que faz o Postgres RE-AVALIAR a função POR LINHA
-- da tabela (advisor `auth_rls_initplan`, 70 políticas / 39 tabelas). Envolver em
-- `(select auth.uid())` transforma numa subquery InitPlan avaliada UMA VEZ por
-- statement — resultado IDÊNTICO, só que muito mais barato em CPU. Esse custo
-- por-linha somado em toda query do app era um dos fatores que, na instância
-- Micro (CPU burstable), levavam a latência a 8-13s sob pico ("spinner em
-- várias telas").
--
-- SEGURANÇA: transformação semanticamente EQUIVALENTE (documentada pelo próprio
-- Supabase). Cada ALTER re-aplica o MESMO predicado, apenas com auth.uid()
-- avaliado uma vez. Nenhuma mudança de quem-acessa-o-quê: continua "cada usuário
-- só enxerga/altera a própria linha" (ou via EXISTS no dono do agregado). Gerado
-- a partir das políticas reais (pg_policies) e revisado. Idempotente: re-aplicar
-- reescreve o mesmo predicado.
-- =============================================================================

ALTER POLICY "Users manage own AI preferences" ON public.ai_conversation_preferences USING (((select auth.uid()) = user_id)) WITH CHECK (((select auth.uid()) = user_id));
ALTER POLICY "Users view own conversation sessions" ON public.conversation_sessions USING (((select auth.uid()) = user_id));
ALTER POLICY elm_delete ON public.english_learning_memory USING (((select auth.uid()) = user_id));
ALTER POLICY elm_insert ON public.english_learning_memory WITH CHECK (((select auth.uid()) = user_id));
ALTER POLICY elm_select ON public.english_learning_memory USING (((select auth.uid()) = user_id));
ALTER POLICY elm_update ON public.english_learning_memory USING (((select auth.uid()) = user_id)) WITH CHECK (((select auth.uid()) = user_id));
ALTER POLICY er_delete ON public.english_reviews USING (((select auth.uid()) = user_id));
ALTER POLICY er_insert ON public.english_reviews WITH CHECK (((select auth.uid()) = user_id));
ALTER POLICY er_select ON public.english_reviews USING (((select auth.uid()) = user_id));
ALTER POLICY er_update ON public.english_reviews USING (((select auth.uid()) = user_id)) WITH CHECK (((select auth.uid()) = user_id));
ALTER POLICY gt_delete ON public.generated_themes USING (((select auth.uid()) = user_id));
ALTER POLICY gt_insert ON public.generated_themes WITH CHECK (((select auth.uid()) = user_id));
ALTER POLICY gt_select ON public.generated_themes USING (((select auth.uid()) = user_id));
ALTER POLICY gt_update ON public.generated_themes USING (((select auth.uid()) = user_id)) WITH CHECK (((select auth.uid()) = user_id));
ALTER POLICY lsp_select ON public.learner_skill_profiles USING (((select auth.uid()) = user_id));
ALTER POLICY ldo_all ON public.learning_day_overrides USING (((select auth.uid()) = user_id)) WITH CHECK (((select auth.uid()) = user_id));
ALTER POLICY placement_owns_row ON public.placement_attempts USING (((select auth.uid()) = user_id));
ALTER POLICY placement_owns_row ON public.placement_c2_responses USING ((EXISTS ( SELECT 1 FROM placement_attempts a WHERE ((a.id = placement_c2_responses.attempt_id) AND (a.user_id = (select auth.uid()))))));
ALTER POLICY pa_select ON public.pronunciation_assessments USING (((select auth.uid()) = user_id));
ALTER POLICY pts_select ON public.pronunciation_training_sessions USING (((select auth.uid()) = user_id));
ALTER POLICY pwa_select_own ON public.pronunciation_word_attempts USING ((user_id = (select auth.uid())));
ALTER POLICY rai_delete ON public.review_attempt_items USING ((EXISTS ( SELECT 1 FROM review_attempts ra WHERE ((ra.id = review_attempt_items.review_attempt_id) AND (ra.user_id = (select auth.uid()))))));
ALTER POLICY rai_insert ON public.review_attempt_items WITH CHECK ((EXISTS ( SELECT 1 FROM review_attempts ra WHERE ((ra.id = review_attempt_items.review_attempt_id) AND (ra.user_id = (select auth.uid()))))));
ALTER POLICY rai_select ON public.review_attempt_items USING ((EXISTS ( SELECT 1 FROM review_attempts ra WHERE ((ra.id = review_attempt_items.review_attempt_id) AND (ra.user_id = (select auth.uid()))))));
ALTER POLICY ra_delete ON public.review_attempts USING (((select auth.uid()) = user_id));
ALTER POLICY ra_insert ON public.review_attempts WITH CHECK (((select auth.uid()) = user_id));
ALTER POLICY ra_select ON public.review_attempts USING (((select auth.uid()) = user_id));
ALTER POLICY rgi_delete ON public.review_group_items USING ((EXISTS ( SELECT 1 FROM review_groups rg WHERE ((rg.id = review_group_items.review_group_id) AND (rg.user_id = (select auth.uid()))))));
ALTER POLICY rgi_insert ON public.review_group_items WITH CHECK ((EXISTS ( SELECT 1 FROM review_groups rg WHERE ((rg.id = review_group_items.review_group_id) AND (rg.user_id = (select auth.uid()))))));
ALTER POLICY rgi_select ON public.review_group_items USING ((EXISTS ( SELECT 1 FROM review_groups rg WHERE ((rg.id = review_group_items.review_group_id) AND (rg.user_id = (select auth.uid()))))));
ALTER POLICY rg_delete ON public.review_groups USING (((select auth.uid()) = user_id));
ALTER POLICY rg_insert ON public.review_groups WITH CHECK (((select auth.uid()) = user_id));
ALTER POLICY rg_select ON public.review_groups USING (((select auth.uid()) = user_id));
ALTER POLICY rg_update ON public.review_groups USING (((select auth.uid()) = user_id)) WITH CHECK (((select auth.uid()) = user_id));
ALTER POLICY ria_delete ON public.review_item_attempts USING (((select auth.uid()) = user_id));
ALTER POLICY ria_insert ON public.review_item_attempts WITH CHECK (((select auth.uid()) = user_id));
ALTER POLICY ria_select ON public.review_item_attempts USING (((select auth.uid()) = user_id));
ALTER POLICY rsh_delete ON public.review_schedule_history USING (((select auth.uid()) = user_id));
ALTER POLICY rsh_insert ON public.review_schedule_history WITH CHECK (((select auth.uid()) = user_id));
ALTER POLICY rsh_select ON public.review_schedule_history USING (((select auth.uid()) = user_id));
ALTER POLICY user_owns_row ON public.user_curriculum_preferences USING (((select auth.uid()) = user_id));
ALTER POLICY user_owns_row ON public.user_curriculum_progress USING (((select auth.uid()) = user_id));
ALTER POLICY ulp_owner_select ON public.user_learning_paths USING (((select auth.uid()) = user_id));
ALTER POLICY uls_all ON public.user_learning_settings USING (((select auth.uid()) = user_id)) WITH CHECK (((select auth.uid()) = user_id));
ALTER POLICY "Users insert own listening assignments" ON public.user_listening_assignments WITH CHECK (((select auth.uid()) = user_id));
ALTER POLICY "Users read own listening assignments" ON public.user_listening_assignments USING (((select auth.uid()) = user_id));
ALTER POLICY "Users update own listening assignments" ON public.user_listening_assignments USING (((select auth.uid()) = user_id)) WITH CHECK (((select auth.uid()) = user_id));
ALTER POLICY "Users read own listening attempts" ON public.user_listening_attempts USING (((select auth.uid()) = user_id));
ALTER POLICY "Users read own block sessions" ON public.user_listening_block_sessions USING (((select auth.uid()) = user_id));
ALTER POLICY "Users read own generation sessions" ON public.user_listening_generation_sessions USING (((select auth.uid()) = user_id));
ALTER POLICY "Users read own listening progress" ON public.user_listening_progress USING (((select auth.uid()) = user_id));
ALTER POLICY "Users read own listening results" ON public.user_listening_results USING (((select auth.uid()) = user_id));
ALTER POLICY "Users insert own shared listening progress" ON public.user_listening_shared_progress WITH CHECK (((select auth.uid()) = user_id));
ALTER POLICY "Users read own shared listening progress" ON public.user_listening_shared_progress USING (((select auth.uid()) = user_id));
ALTER POLICY "Users update own shared listening progress" ON public.user_listening_shared_progress USING (((select auth.uid()) = user_id)) WITH CHECK (((select auth.uid()) = user_id));
ALTER POLICY prr_all_own ON public.user_practice_reminder_preferences USING (((select auth.uid()) = user_id)) WITH CHECK (((select auth.uid()) = user_id));
ALTER POLICY uscu_select_own ON public.user_shared_content_usage USING (((select auth.uid()) = user_id));
ALTER POLICY user_owns_row ON public.user_subtopic_completion USING (((select auth.uid()) = user_id));
ALTER POLICY user_owns_row ON public.user_subtopic_modality_progress USING (((select auth.uid()) = user_id));
ALTER POLICY we_delete ON public.writing_entries USING (((select auth.uid()) = user_id));
ALTER POLICY we_insert ON public.writing_entries WITH CHECK (((select auth.uid()) = user_id));
ALTER POLICY we_select ON public.writing_entries USING (((select auth.uid()) = user_id));
ALTER POLICY we_update ON public.writing_entries USING (((select auth.uid()) = user_id)) WITH CHECK (((select auth.uid()) = user_id));
ALTER POLICY wrr_select ON public.writing_review_reservations USING (((select auth.uid()) = user_id));
ALTER POLICY "Users insert own rewrite draft" ON public.writing_rewrite_attempts WITH CHECK ((((select auth.uid()) = user_id) AND (status = 'draft'::rewrite_status) AND (author_type = 'learner'::text) AND (submission_type = 'rewrite_v2'::text)));
ALTER POLICY "Users read own rewrite attempts" ON public.writing_rewrite_attempts USING (((select auth.uid()) = user_id));
ALTER POLICY "Users update own draft rewrite text" ON public.writing_rewrite_attempts USING ((((select auth.uid()) = user_id) AND (status = 'draft'::rewrite_status))) WITH CHECK ((((select auth.uid()) = user_id) AND (status = 'draft'::rewrite_status)));
ALTER POLICY "Users read own outcomes via evaluation" ON public.writing_rewrite_correction_outcomes USING ((EXISTS ( SELECT 1 FROM writing_rewrite_evaluations wre WHERE ((wre.id = writing_rewrite_correction_outcomes.rewrite_evaluation_id) AND (wre.user_id = (select auth.uid()))))));
ALTER POLICY "Users read own evaluations" ON public.writing_rewrite_evaluations USING (((select auth.uid()) = user_id));
ALTER POLICY "Users read own evidence candidates" ON public.writing_rewrite_evidence_candidates USING (((select auth.uid()) = user_id));
