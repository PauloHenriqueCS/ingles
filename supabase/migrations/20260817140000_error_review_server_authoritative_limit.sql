-- =============================================================================
-- MIGRATION: 20260817140000_error_review_server_authoritative_limit
-- Projeto: Orodim
--
-- Aplicada automaticamente por .github/workflows/deploy-production.yml
-- (supabase db push) após o merge na main, e por homologation.yml em develop.
-- Não aplicar manualmente no SQL Editor.
--
-- OBJETIVO (endurecimento de segurança da atividade "Revisar meus erros"):
--
--   1) O LIMITE de 10 exercícios/dia passa a ser AUTORITATIVO NO BANCO. Antes,
--      get_error_review_session e submit_error_review_item confiavam no
--      parâmetro p_daily_limit vindo do cliente — uma chamada direta à RPC com
--      p_daily_limit = 100 ultrapassava o teto. Agora o valor efetivo é
--      LEAST(COALESCE(p_daily_limit, 10), 10), com piso 0. O parâmetro continua
--      aceito (compat de assinatura/chamadas), mas NUNCA pode elevar o teto
--      acima de 10.
--
--   2) A FRONTEIRA DO DIA passa a ser AUTORITATIVA NO BANCO, em America/Sao_Paulo.
--      Antes, "respondidos hoje" e o activity_date gravado vinham do parâmetro
--      p_activity_date do cliente — um cliente podia mandar uma data diferente a
--      cada chamada e zerar a contagem, furando o limite por completo. Agora o
--      dia efetivo é (now() AT TIME ZONE 'America/Sao_Paulo')::date, calculado no
--      servidor; p_activity_date é ignorado para autoridade. O reset diário vira
--      exatamente na virada de data em São Paulo (22:30 SP do dia 17 ainda é 17).
--
-- Concorrência (múltiplas abas/dispositivos) continua protegida pelo
-- pg_advisory_xact_lock por usuário já presente no submit: a 11ª tentativa é
-- rejeitada mesmo que o cliente tenha carregado cards antes.
--
-- Apenas CREATE OR REPLACE (mesmas assinaturas) — grants e chamadas do
-- frontend permanecem válidos. Idempotente, sem tocar dados nem histórico.
-- Após aplicar: execute supabase/verify_schema.sql para verificar o estado.
-- =============================================================================

-- Teto de segurança absoluto: nunca mais que 10 respostas por usuário por dia.
-- É um limite de SEGURANÇA (defesa em profundidade), não um número comercial por
-- plano — por isso vive aqui como piso duro do LEAST, e o cliente só pode pedir
-- um valor MENOR, nunca maior.

CREATE OR REPLACE FUNCTION public.get_error_review_session(
  p_activity_date date,
  p_daily_limit   integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_user      uuid;
  v_day       date;
  v_limit     integer;
  v_consumed  integer;
  v_due_total integer;
  v_available integer;
  v_items     jsonb;
BEGIN
  v_user := auth.uid();
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('error', 'UNAUTHORIZED');
  END IF;

  -- Dia autoritativo (São Paulo) e limite autoritativo (teto duro de 10).
  v_day   := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_limit := greatest(0, least(COALESCE(p_daily_limit, 10), 10));

  SELECT count(*) INTO v_consumed
  FROM public.review_item_attempts
  WHERE user_id = v_user AND activity_date = v_day;

  SELECT count(*) INTO v_due_total
  FROM public.review_group_items
  WHERE user_id = v_user
    AND status = 'scheduled'
    AND next_review_at IS NOT NULL
    AND next_review_at <= now();

  v_available := greatest(0, v_limit - v_consumed);
  v_available := least(v_available, v_due_total);

  SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb) INTO v_items
  FROM (
    SELECT id,
           original_value    AS "originalValue",
           original_sentence AS "originalSentence"
    FROM public.review_group_items
    WHERE user_id = v_user
      AND status = 'scheduled'
      AND next_review_at IS NOT NULL
      AND next_review_at <= now()
    ORDER BY next_review_at ASC, created_at ASC
    LIMIT v_available
  ) t;

  RETURN jsonb_build_object(
    'available',  v_available,
    'dueTotal',   v_due_total,
    'consumed',   v_consumed,
    'dailyLimit', v_limit,
    'items',      v_items
  );
END $$;

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
