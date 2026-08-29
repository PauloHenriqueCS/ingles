-- =============================================================================
-- MIGRATION: 20260829120200_review_behavioral_push_attribution
-- Projeto: Orodim
--
-- Aplicada automaticamente por .github/workflows/homologation.yml
-- (supabase db push). NÃO aplicar manualmente no SQL Editor.
--
-- OBJETIVO: ligar a atribuição de push comportamental ao ÚNICO ponto de
-- conclusão server-authoritative da atividade "Revisar meus erros". Diferente
-- das outras 4 modalidades, a Revisão NÃO tem endpoint Node — o cliente chama
-- direto a RPC submit_error_review_item. Então o gancho de atribuição precisa
-- viver DENTRO da própria RPC.
--
-- ESCOPO: recria submit_error_review_item IDÊNTICA à versão de
-- 20260817140000_error_review_server_authoritative_limit.sql, adicionando
-- APENAS uma chamada best-effort e ISOLADA a
-- record_behavioral_push_activity_conversion após o INSERT do attempt. Um bloco
-- BEGIN/EXCEPTION engole qualquer erro: o tracking de push jamais pode fazer uma
-- submissão de revisão falhar (best-effort + idempotente + isolado). Nada mais
-- da função muda.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.submit_error_review_item(
  p_item_id        uuid,
  p_submitted_text text,
  p_activity_date  date,
  p_daily_limit    integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_user       uuid;
  v_day        date;
  v_limit      integer;
  v_item       record;
  v_consumed   integer;
  v_sub        text;
  v_cor        text;
  v_org        text;
  v_passed     boolean;
  v_prev_lvl   integer;
  v_new_lvl    integer;
  v_new_status text;
  v_new_next   timestamptz;
  v_interval   integer;
  v_mastered   boolean := false;
BEGIN
  v_user := auth.uid();
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('error', 'UNAUTHORIZED');
  END IF;

  -- Dia e limite AUTORITATIVOS no servidor (cliente não é autoridade).
  v_day   := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_limit := greatest(0, least(COALESCE(p_daily_limit, 10), 10));

  -- Serializa todas as submissões de revisão deste usuário (limite diário).
  PERFORM pg_advisory_xact_lock(hashtext(v_user::text || ':error_review'));

  -- Carrega e trava o item (escopo explícito por user_id).
  SELECT * INTO v_item
  FROM public.review_group_items
  WHERE id = p_item_id AND user_id = v_user
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'NOT_FOUND');
  END IF;

  IF v_item.status = 'mastered' THEN
    RETURN jsonb_build_object('error', 'ALREADY_MASTERED');
  END IF;

  -- Limite diário autoritativo: conta pelo dia SP do servidor, com teto 10.
  -- Impede a 11ª tentativa mesmo que o cliente tenha carregado cards antes ou
  -- passe p_daily_limit inflado / p_activity_date de outro dia.
  SELECT count(*) INTO v_consumed
  FROM public.review_item_attempts
  WHERE user_id = v_user AND activity_date = v_day;

  IF v_consumed >= v_limit THEN
    RETURN jsonb_build_object('error', 'DAILY_LIMIT_REACHED', 'consumed', v_consumed);
  END IF;

  -- Correção determinística.
  v_sub := public.error_review_normalize(p_submitted_text);
  v_cor := public.error_review_normalize(v_item.corrected_value);
  v_org := public.error_review_normalize(v_item.original_value);
  v_passed := (v_sub = v_cor) AND (v_cor = v_org OR v_sub <> v_org);

  v_prev_lvl := v_item.review_level;

  IF v_passed THEN
    IF v_prev_lvl >= 3 THEN
      v_new_lvl := 4;
      v_new_status := 'mastered';
      v_new_next := NULL;
      v_interval := NULL;
      v_mastered := true;
    ELSE
      v_new_lvl := v_prev_lvl + 1;
      v_interval := CASE v_new_lvl WHEN 1 THEN 7 WHEN 2 THEN 30 WHEN 3 THEN 120 END;
      v_new_next := now() + make_interval(days => v_interval);
      v_new_status := 'scheduled';
    END IF;
  ELSE
    v_new_lvl := 0;
    v_interval := 1;
    v_new_next := now() + interval '1 day';
    v_new_status := 'scheduled';
  END IF;

  UPDATE public.review_group_items
  SET review_level   = v_new_lvl,
      status         = v_new_status,
      next_review_at = v_new_next,
      last_review_at = now(),
      mastered_at    = CASE WHEN v_mastered THEN now() ELSE mastered_at END
  WHERE id = p_item_id;

  -- activity_date gravado é o dia SP do servidor (nunca o do cliente).
  INSERT INTO public.review_item_attempts (
    user_id, review_group_item_id, submitted_text,
    passed, review_level_before, review_level_after, activity_date
  ) VALUES (
    v_user, p_item_id, p_submitted_text,
    v_passed, v_prev_lvl, v_new_lvl, v_day
  );

  -- Atribuição de push comportamental (associação, não causalidade). ISOLADA:
  -- o bloco engole qualquer erro para que o tracking jamais faça a submissão
  -- falhar. Idempotente (primeira atividade vence, garantido na função).
  BEGIN
    PERFORM public.record_behavioral_push_activity_conversion(v_user, 'review', now());
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN jsonb_build_object(
    'passed',         v_passed,
    'correctedValue', v_item.corrected_value,
    'originalValue',  v_item.original_value,
    'explanation',    v_item.explanation,
    'newLevel',       v_new_lvl,
    'newStatus',      v_new_status,
    'nextReviewAt',   v_new_next,
    'intervalDays',   v_interval,
    'mastered',       v_mastered,
    'consumed',       v_consumed + 1
  );
END $$;
