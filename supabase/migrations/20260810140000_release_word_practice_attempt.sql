-- =============================================================================
-- MIGRATION: 20260810140000_release_word_practice_attempt
-- Projeto: Orodim
--
-- Aplicada automaticamente por .github/workflows/homologation.yml
-- (supabase db push) após push em develop. Não aplicar manualmente no SQL
-- Editor — isso desalinha o histórico de `supabase migration list`.
--
-- OBJETIVO: devolver UMA tentativa do treino de palavra individual quando o
-- PRÓPRIO SERVIDOR falha ao emitir o token Azure DEPOIS de já ter
-- incrementado a tentativa (ver register_word_practice_attempt em
-- 20260810120000). Sem token entregue não há avaliação client-side, então
-- a tentativa não deveria ser consumida.
--
-- POR QUE UMA RPC SEPARADA E SÓ PARA service_role:
--   Se este decremento fosse chamável pelo cliente (authenticated), abriria
--   exatamente o bypass que o limite de 3 tentativas existe para impedir:
--   registrar -> "devolver" -> registrar de novo, infinitamente. Por isso a
--   função só recebe GRANT para service_role e é chamada APENAS pelo backend,
--   no caminho de erro de emissão do token (api/pronunciation-training/
--   [...slug].ts handleToken). O escopo (user_id, owner_type, owner_id,
--   palavra normalizada) é passado explicitamente pelo backend — que acabou
--   de registrar exatamente essa tentativa — e não depende de auth.uid()
--   (nulo sob service_role).
--
--   NUNCA fazer refund por sinal reportado pelo cliente (SDK Azure falhou,
--   conversão falhou, rede caiu após o token, modal fechado): esses são
--   controláveis pelo cliente e reabririam o bypass. Refund SOMENTE quando o
--   servidor sabe que não entregou o token.
--
-- ESCOPO: puramente aditivo (uma função nova). Não altera a tabela, o
-- register, o limite de 3, os 8s, nem qualquer fluxo de texto completo.
-- =============================================================================

-- Decremento atômico de 1 na linha exata da tentativa recém-consumida.
-- Nunca abaixo de zero (GREATEST). Se a linha não existir (nada a devolver),
-- é um no-op idempotente. Uma única UPDATE = trava de linha atômica: duas
-- devoluções concorrentes da mesma palavra serializam e cada uma remove no
-- máximo 1, jamais interferindo em tentativas válidas concorrentes (que
-- passam pelo register, uma statement atômica distinta).
CREATE OR REPLACE FUNCTION public.release_word_practice_attempt(
  p_user_id uuid,
  p_owner_type text,
  p_owner_id uuid,
  p_word text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_word text;
  v_count integer;
BEGIN
  IF p_user_id IS NULL OR p_owner_id IS NULL THEN
    RETURN jsonb_build_object('error', 'INVALID_ARGS');
  END IF;
  IF p_owner_type IS NULL OR p_owner_type NOT IN ('training', 'writing') THEN
    RETURN jsonb_build_object('error', 'INVALID_OWNER_TYPE');
  END IF;

  -- Mesma normalização de register_word_practice_attempt.
  v_word := lower(btrim(COALESCE(p_word, '')));
  v_word := regexp_replace(v_word, '^[^a-z0-9]+', '');
  v_word := regexp_replace(v_word, '[^a-z0-9]+$', '');
  IF v_word = '' THEN
    RETURN jsonb_build_object('error', 'INVALID_WORD');
  END IF;

  UPDATE public.pronunciation_word_attempts
    SET attempt_count = GREATEST(attempt_count - 1, 0),
        updated_at = now()
    WHERE user_id = p_user_id
      AND owner_type = p_owner_type
      AND owner_id = p_owner_id
      AND word_normalized = v_word
  RETURNING attempt_count INTO v_count;

  -- Sem linha => nada a devolver (no-op idempotente).
  RETURN jsonb_build_object('attemptsUsed', COALESCE(v_count, 0));
END;
$$;

-- Backend-only: NUNCA para authenticated/anon (evita o bypass registrar->
-- devolver->registrar). Chamada apenas pelo service_role a partir do handler.
REVOKE ALL ON FUNCTION public.release_word_practice_attempt(uuid, text, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.release_word_practice_attempt(uuid, text, uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.release_word_practice_attempt(uuid, text, uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.release_word_practice_attempt(uuid, text, uuid, text) TO service_role;
