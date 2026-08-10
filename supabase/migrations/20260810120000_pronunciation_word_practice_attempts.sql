-- =============================================================================
-- MIGRATION: 20260810120000_pronunciation_word_practice_attempts
-- Projeto: Orodim
--
-- Aplicada automaticamente por .github/workflows/homologation.yml
-- (supabase db push) após push em develop. Não aplicar manualmente no SQL
-- Editor — isso desalinha o histórico de `supabase migration list`.
--
-- OBJETIVO: limitar o TREINO DE PALAVRAS INDIVIDUAIS (o microfone "re-praticar"
-- por palavra na tela de resultado) a no máximo 3 tentativas POR PALAVRA, com
-- a contagem persistida server-side para que o limite não possa ser burlado
-- chamando a API diretamente / resetando estado do React / localStorage.
--
-- POR QUE UMA TABELA NOVA (e não uma coluna/estrutura existente):
--   As duas superfícies de treino individual (WordRow em
--   PronunciationTrainingView e PracticeWordRow em PronunciationWordGrid) hoje
--   NÃO persistem nada por palavra — só buscam um token Azure em
--   /api/pronunciation-training/token e rodam o reconhecimento no cliente
--   (confirmado: nenhuma tabela/coluna de tentativa por palavra existe no
--   baseline). Portanto registrar tentativas por palavra é genuinamente novo.
--   Uma única tabela com (owner_type, owner_id) cobre as DUAS superfícies de
--   forma uniforme — 'training' ancora em pronunciation_training_sessions e
--   'writing' ancora em english_reviews (o text_version_id / reviewId) — sem
--   acoplar a duas tabelas-pai distintas nem duplicar RPCs.
--
-- ESCOPO: NADA aqui toca no fluxo de TEXTO COMPLETO (reserve/complete/fail de
-- pronunciation_assessments ou pronunciation_training_sessions), nos limites de
-- duração de gravação do plano (maxRecordingSeconds), nas quotas de avaliação,
-- geração diária de texto, planos, trial, preços ou telemetria/gateway. É
-- puramente aditivo: uma tabela nova + uma função nova.
-- =============================================================================

-- ── Tabela de contagem de tentativas por palavra ────────────────────────────
CREATE TABLE IF NOT EXISTS public.pronunciation_word_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- 'training' => pronunciation_training_sessions.id
  -- 'writing'  => english_reviews.id (text_version_id / reviewId)
  owner_type text NOT NULL,
  owner_id uuid NOT NULL,
  -- Chave normalizada da palavra (lower + strip de pontuação nas bordas),
  -- espelha src/domain/pronunciation/word-practice-limits.ts.
  word_normalized text NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT pronunciation_word_attempts_owner_type_check
    CHECK (owner_type IN ('training', 'writing')),
  CONSTRAINT pronunciation_word_attempts_count_nonneg_check
    CHECK (attempt_count >= 0),
  CONSTRAINT pronunciation_word_attempts_unique_word
    UNIQUE (owner_type, owner_id, word_normalized)
);

COMMENT ON TABLE public.pronunciation_word_attempts IS
  'Contagem server-side de tentativas do treino de PALAVRA INDIVIDUAL (máx. 3 por palavra), por (owner_type, owner_id, word_normalized). owner_type=training->pronunciation_training_sessions, writing->english_reviews. Escrita apenas via register_word_practice_attempt (SECURITY DEFINER).';

CREATE INDEX IF NOT EXISTS idx_pronunciation_word_attempts_owner
  ON public.pronunciation_word_attempts (owner_type, owner_id);
CREATE INDEX IF NOT EXISTS idx_pronunciation_word_attempts_user
  ON public.pronunciation_word_attempts (user_id);

DROP TRIGGER IF EXISTS trg_pronunciation_word_attempts_updated_at ON public.pronunciation_word_attempts;
CREATE TRIGGER trg_pronunciation_word_attempts_updated_at
  BEFORE UPDATE ON public.pronunciation_word_attempts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── RLS + grants ────────────────────────────────────────────────────────────
-- Leitura: só as próprias linhas (útil para depuração; o cliente na prática lê
-- attemptsUsed do retorno da RPC, não faz SELECT direto). Escrita: nunca por
-- authenticated — só a função SECURITY DEFINER abaixo (rodando como owner)
-- insere/atualiza, então NÃO há GRANT INSERT/UPDATE para authenticated.
-- Tabela nova não herda privilégio nenhum neste banco (pg_default_acl vazio),
-- então todo GRANT é explícito.
ALTER TABLE public.pronunciation_word_attempts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pwa_select_own ON public.pronunciation_word_attempts;
CREATE POLICY pwa_select_own ON public.pronunciation_word_attempts
  FOR SELECT USING (user_id = auth.uid());

REVOKE ALL ON public.pronunciation_word_attempts FROM PUBLIC;
REVOKE ALL ON public.pronunciation_word_attempts FROM anon;
REVOKE ALL ON public.pronunciation_word_attempts FROM authenticated;
GRANT SELECT ON public.pronunciation_word_attempts TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.pronunciation_word_attempts TO service_role;

-- ── RPC: registra 1 tentativa da palavra, atômico, com verificação de dono ──
-- Retorna jsonb:
--   { "attemptsUsed": <n> }                               em sucesso (n<=máx)
--   { "error": "WORD_ATTEMPT_LIMIT_REACHED", "attemptsUsed": <máx> }  se estourou
--   { "error": "UNAUTHORIZED" | "INVALID_OWNER_TYPE" | "INVALID_WORD" | "OWNER_NOT_FOUND" }
--
-- A CONTAGEM É INCREMENTADA ANTES da emissão do token Azure (no caller), de
-- propósito: é exatamente o incremento que faz o gate — emitir o token e só
-- então contar abriria brecha para bypass (basta pedir o token e ignorar a
-- contagem). Por isso o registro/gate acontece primeiro; a 4ª chamada nunca
-- recebe token.
--
-- Race condition: o incremento usa INSERT ... ON CONFLICT DO UPDATE com WHERE
-- attempt_count < p_max_attempts, que trava a linha no conflito; duas chamadas
-- simultâneas na 3ª tentativa serializam — uma grava 3, a outra reavalia o
-- WHERE já com 3 e não atualiza (RETURNING vazio => limite atingido). Assim
-- nunca passa de p_max_attempts mesmo sob concorrência.
CREATE OR REPLACE FUNCTION public.register_word_practice_attempt(
  p_owner_type text,
  p_owner_id uuid,
  p_word text,
  p_max_attempts integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_word text;
  v_owns boolean := false;
  v_count integer;
  v_max integer := COALESCE(p_max_attempts, 3);
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('error', 'UNAUTHORIZED');
  END IF;
  IF p_owner_type IS NULL OR p_owner_type NOT IN ('training', 'writing') THEN
    RETURN jsonb_build_object('error', 'INVALID_OWNER_TYPE');
  END IF;
  IF p_owner_id IS NULL THEN
    RETURN jsonb_build_object('error', 'OWNER_NOT_FOUND');
  END IF;
  IF v_max < 1 THEN
    v_max := 1;
  END IF;

  -- Normalização espelha normalizeWordForPractice() no cliente.
  v_word := lower(btrim(COALESCE(p_word, '')));
  v_word := regexp_replace(v_word, '^[^a-z0-9]+', '');
  v_word := regexp_replace(v_word, '[^a-z0-9]+$', '');
  IF v_word = '' THEN
    RETURN jsonb_build_object('error', 'INVALID_WORD');
  END IF;

  -- Verificação de dono: o owner_id precisa pertencer ao usuário autenticado.
  -- Impede que um chamador direto forje um contexto (ou reaproveite o de outra
  -- pessoa) para zerar/escapar da contagem.
  IF p_owner_type = 'training' THEN
    SELECT EXISTS (
      SELECT 1 FROM public.pronunciation_training_sessions s
      WHERE s.id = p_owner_id AND s.user_id = v_user
    ) INTO v_owns;
  ELSE
    SELECT EXISTS (
      SELECT 1 FROM public.english_reviews r
      WHERE r.id = p_owner_id AND r.user_id = v_user
    ) INTO v_owns;
  END IF;

  IF NOT v_owns THEN
    RETURN jsonb_build_object('error', 'OWNER_NOT_FOUND');
  END IF;

  -- Incremento atômico com teto. Retorna a nova contagem quando permitido;
  -- não retorna linha (v_count = NULL) quando já estava no teto.
  INSERT INTO public.pronunciation_word_attempts AS w
    (user_id, owner_type, owner_id, word_normalized, attempt_count)
  VALUES (v_user, p_owner_type, p_owner_id, v_word, 1)
  ON CONFLICT (owner_type, owner_id, word_normalized) DO UPDATE
    SET attempt_count = w.attempt_count + 1,
        updated_at = now()
    WHERE w.attempt_count < v_max
  RETURNING w.attempt_count INTO v_count;

  IF v_count IS NULL THEN
    RETURN jsonb_build_object('error', 'WORD_ATTEMPT_LIMIT_REACHED', 'attemptsUsed', v_max);
  END IF;

  RETURN jsonb_build_object('attemptsUsed', v_count);
END;
$$;

REVOKE ALL ON FUNCTION public.register_word_practice_attempt(text, uuid, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.register_word_practice_attempt(text, uuid, text, integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.register_word_practice_attempt(text, uuid, text, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.register_word_practice_attempt(text, uuid, text, integer) TO service_role;

-- Após aplicar: confirme os grants da tabela
--   SELECT grantee, privilege_type FROM information_schema.role_table_grants
--   WHERE table_schema='public' AND table_name='pronunciation_word_attempts'
--   ORDER BY grantee, privilege_type;
-- deve retornar postgres (owner), authenticated (SELECT) e service_role
-- (SELECT, INSERT, UPDATE) — nunca INSERT/UPDATE para authenticated/anon.
