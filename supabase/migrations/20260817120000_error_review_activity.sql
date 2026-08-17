-- =============================================================================
-- MIGRATION: 20260817120000_error_review_activity
-- Projeto: Orodim
--
-- Aplicada automaticamente por .github/workflows/deploy-production.yml
-- (supabase db push) após o merge na main, e por homologation.yml em develop.
-- Não aplicar manualmente no SQL Editor.
--
-- OBJETIVO: transformar a "Revisão de erros" numa ATIVIDADE INDEPENDENTE da
-- Escrita, com AGENDAMENTO POR ITEM (cada erro tem seu próprio ciclo de
-- repetição espaçada), limite diário e captura preservada.
--
-- Antes: a Escrita futura era sequestrada para virar uma sessão de revisão
-- (mode:'review', palavras obrigatórias) e o agendamento era por GRUPO
-- (review_groups) — acertar/errar um erro avançava/resetava o grupo inteiro.
--
-- Agora: review_group_items vira a ENTIDADE DE CARD, com scheduler próprio.
-- review_groups continua como ORIGEM/AGREGADOR da correção (histórico intacto).
-- O scheduler de grupo antigo (apply_review_schedule) fica dormente — a Escrita
-- não gera mais missões de revisão, então nada o dispara.
--
-- SCHEDULER APROVADO (por item):
--   novo erro → +1 dia → (acertou) +7 → (acertou) +30 → (acertou) +120 →
--   (acertou) mastered.  Errar em qualquer etapa → volta ao início (+1 dia).
--
-- LIMITE: até 10 exercícios de revisão por dia (número passado como parâmetro
-- pelo código — nunca embutido no SQL). Abrir/carregar NÃO consome; só uma
-- resposta efetivamente submetida (submit_error_review_item) cria tentativa e
-- move o scheduler.
--
-- SEGURANÇA: remove as policies permissivas legadas de english_reviews
-- (auth.uid() = user_id OR user_id IS NULL) que vazavam linhas órfãs; as
-- policies estritas er_* permanecem. Todas as RPCs são SECURITY DEFINER e
-- escopam explicitamente por auth.uid().
--
-- Idempotente e sem operações destrutivas de histórico.
-- Após aplicar: execute supabase/verify_schema.sql para verificar o estado.
-- =============================================================================

-- =====================================================================
-- 1. review_group_items vira a entidade de card (scheduler por item)
-- =====================================================================

ALTER TABLE public.review_group_items
  ADD COLUMN IF NOT EXISTS user_id        uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS status         text NOT NULL DEFAULT 'scheduled',
  ADD COLUMN IF NOT EXISTS review_level   integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_review_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_review_at timestamptz,
  ADD COLUMN IF NOT EXISTS mastered_at    timestamptz,
  ADD COLUMN IF NOT EXISTS reactivated_at timestamptz,
  ADD COLUMN IF NOT EXISTS concept_key    text;

-- status só pode ser 'scheduled' (em revisão) ou 'mastered' (dominado).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'review_group_items_status_check'
  ) THEN
    ALTER TABLE public.review_group_items
      ADD CONSTRAINT review_group_items_status_check
      CHECK (status IN ('scheduled', 'mastered'));
  END IF;
END $$;

-- Backfill conservador dos itens já existentes (item #26 — não apagar estado):
--   * user_id vem do grupo pai.
--   * grupo dominado → item mastered (não reabrimos retroativamente).
--   * demais → nível 0, agendados para quando o grupo já estava agendado
--     (coalesce para agora), começando um ciclo por item limpo.
UPDATE public.review_group_items i
   SET user_id = g.user_id
  FROM public.review_groups g
 WHERE g.id = i.review_group_id
   AND i.user_id IS NULL;

UPDATE public.review_group_items i
   SET status         = 'mastered',
       mastered_at    = COALESCE(i.mastered_at, now()),
       next_review_at = NULL
  FROM public.review_groups g
 WHERE g.id = i.review_group_id
   AND g.status = 'mastered'
   AND i.status <> 'mastered';

UPDATE public.review_group_items i
   SET next_review_at = COALESCE(g.next_review_at, now())
  FROM public.review_groups g
 WHERE g.id = i.review_group_id
   AND i.status = 'scheduled'
   AND i.next_review_at IS NULL;

-- Garante user_id preenchido em toda inserção nova, inclusive se o cliente
-- (janela de deploy) enviar sem user_id — deriva do grupo dono da linha.
CREATE OR REPLACE FUNCTION public.set_review_group_item_user_id()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
  IF NEW.user_id IS NULL THEN
    SELECT user_id INTO NEW.user_id
    FROM public.review_groups
    WHERE id = NEW.review_group_id;
  END IF;
  -- Novo erro capturado sem agendamento explícito → primeira revisão em +1 dia.
  IF NEW.next_review_at IS NULL AND NEW.status = 'scheduled' THEN
    NEW.next_review_at := now() + interval '1 day';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_set_review_group_item_user_id ON public.review_group_items;
CREATE TRIGGER trg_set_review_group_item_user_id
  BEFORE INSERT ON public.review_group_items
  FOR EACH ROW EXECUTE FUNCTION public.set_review_group_item_user_id();

-- Índice da fila "vencidos por usuário" (status + próxima revisão).
CREATE INDEX IF NOT EXISTS idx_rgi_user_status_next
  ON public.review_group_items (user_id, status, next_review_at);

-- =====================================================================
-- 2. review_item_attempts — log de tentativa POR ITEM (conta o limite
--    diário e alimenta o comportamento de reabrir sessão).
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.review_item_attempts (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  review_group_item_id uuid NOT NULL REFERENCES public.review_group_items(id) ON DELETE CASCADE,
  submitted_text       text,
  passed               boolean NOT NULL,
  review_level_before  integer NOT NULL,
  review_level_after   integer NOT NULL,
  activity_date        date NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.review_item_attempts ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_ria_user_activity_date
  ON public.review_item_attempts (user_id, activity_date);

CREATE INDEX IF NOT EXISTS idx_ria_item
  ON public.review_item_attempts (review_group_item_id);

DROP POLICY IF EXISTS "ria_select" ON public.review_item_attempts;
DROP POLICY IF EXISTS "ria_insert" ON public.review_item_attempts;
DROP POLICY IF EXISTS "ria_delete" ON public.review_item_attempts;

CREATE POLICY "ria_select" ON public.review_item_attempts
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "ria_insert" ON public.review_item_attempts
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "ria_delete" ON public.review_item_attempts
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- =====================================================================
-- 3. Normalização determinística de resposta
--    Ignora diferenças irrelevantes de caixa, espaços e pontuação final,
--    sem alterar a correção avaliada. Espelhada 1:1 em
--    src/domain/error-review/answer-check.ts (referência testada).
-- =====================================================================

CREATE OR REPLACE FUNCTION public.error_review_normalize(p_text text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT btrim(
           regexp_replace(lower(coalesce(p_text, '')), '\s+', ' ', 'g'),
           E' \t\n\r.,!?;:"''`()[]{}'
         );
$$;

-- =====================================================================
-- 4. get_error_review_session — fila do dia (NÃO consome nada).
--    Retorna a quantidade disponível hoje (limitada ao limite diário) e a
--    lista de itens vencidos a servir, SEM a correção (corrected_value/
--    explanation ficam no servidor até a resposta ser submetida — item #14).
-- =====================================================================

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
  v_consumed  integer;
  v_due_total integer;
  v_available integer;
  v_items     jsonb;
BEGIN
  v_user := auth.uid();
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('error', 'UNAUTHORIZED');
  END IF;

  SELECT count(*) INTO v_consumed
  FROM public.review_item_attempts
  WHERE user_id = v_user AND activity_date = p_activity_date;

  SELECT count(*) INTO v_due_total
  FROM public.review_group_items
  WHERE user_id = v_user
    AND status = 'scheduled'
    AND next_review_at IS NOT NULL
    AND next_review_at <= now();

  v_available := greatest(0, COALESCE(p_daily_limit, 0) - v_consumed);
  v_available := least(v_available, v_due_total);

  SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb) INTO v_items
  FROM (
    SELECT id,
           original_value   AS "originalValue",
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
    'dailyLimit', COALESCE(p_daily_limit, 0),
    'items',      v_items
  );
END $$;

-- =====================================================================
-- 5. submit_error_review_item — ÚNICO ponto que consome/agenda.
--    Atômico e concurrency-safe:
--      * advisory lock por usuário serializa a checagem+inserção do limite,
--        garantindo no máximo N por dia mesmo sob submissões concorrentes.
--      * calcula acerto/erro no servidor (a correção nunca sai antes da
--        resposta) via error_review_normalize; rejeita respostas que
--        preservam o próprio erro sob revisão.
--      * scheduler por item: pass → +7/+30/+120/mastered; fail → +1 (nível 0).
-- =====================================================================

CREATE OR REPLACE FUNCTION public.submit_error_review_item(
  p_item_id       uuid,
  p_submitted_text text,
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
  v_item      record;
  v_consumed  integer;
  v_sub       text;
  v_cor       text;
  v_org       text;
  v_passed    boolean;
  v_prev_lvl  integer;
  v_new_lvl   integer;
  v_new_status text;
  v_new_next  timestamptz;
  v_interval  integer;
  v_mastered  boolean := false;
BEGIN
  v_user := auth.uid();
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('error', 'UNAUTHORIZED');
  END IF;

  -- Serializa todas as submissões de revisão deste usuário (limite diário).
  PERFORM pg_advisory_xact_lock(hashtext(v_user::text || ':error_review'));

  -- Carrega e trava o item (RLS-independent: escopo explícito por user_id).
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

  -- Limite diário (número vem do código, nunca embutido aqui).
  SELECT count(*) INTO v_consumed
  FROM public.review_item_attempts
  WHERE user_id = v_user AND activity_date = p_activity_date;

  IF v_consumed >= COALESCE(p_daily_limit, 0) THEN
    RETURN jsonb_build_object('error', 'DAILY_LIMIT_REACHED', 'consumed', v_consumed);
  END IF;

  -- Correção determinística.
  v_sub := public.error_review_normalize(p_submitted_text);
  v_cor := public.error_review_normalize(v_item.corrected_value);
  v_org := public.error_review_normalize(v_item.original_value);
  -- Passa quando bate com a forma correta E não é apenas a manutenção do erro
  -- (a menos que correto e errado sejam iguais após normalização — diferença
  --  puramente cosmética).
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

  INSERT INTO public.review_item_attempts (
    user_id, review_group_item_id, submitted_text,
    passed, review_level_before, review_level_after, activity_date
  ) VALUES (
    v_user, p_item_id, p_submitted_text,
    v_passed, v_prev_lvl, v_new_lvl, p_activity_date
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

-- =====================================================================
-- 6. Grants — apenas usuários autenticados e service_role.
-- =====================================================================

REVOKE ALL ON FUNCTION public.get_error_review_session(date, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_error_review_session(date, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_error_review_session(date, integer) TO service_role;

REVOKE ALL ON FUNCTION public.submit_error_review_item(uuid, text, date, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_error_review_item(uuid, text, date, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.submit_error_review_item(uuid, text, date, integer) TO service_role;

-- =====================================================================
-- 7. SEGURANÇA — remove as policies permissivas legadas de english_reviews.
--    Elas concediam SELECT/INSERT quando (auth.uid() = user_id OR
--    user_id IS NULL); como o Postgres faz OR entre policies permissivas,
--    o ramo "user_id IS NULL" continuava vazando linhas órfãs. As policies
--    estritas er_select/er_insert/er_update/er_delete (auth.uid() = user_id)
--    permanecem e são suficientes.
-- =====================================================================

DROP POLICY IF EXISTS "Allow read english reviews"   ON public.english_reviews;
DROP POLICY IF EXISTS "Allow insert english reviews"  ON public.english_reviews;
