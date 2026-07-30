-- =============================================================================
-- MIGRATION: 20260727224200_authorize_trial_conversation_session
-- Projeto: Lemon
--
-- Histórico de renomeações (Etapa 2A/2B — revisão de versionamento), nenhuma
-- delas aplicada em nenhum ambiente:
--   20260727020000 → uma migration irmã desta (20260727000000) colidia com
--     uma migration já aplicada pelo ingles-dashboad em lemon-homolog
--     (versão real 20260727223126).
--   20260728020000 → data artificialmente no futuro (hoje é 27/07/2026) —
--     corrigida para 20260727224200, mesma data de hoje, posterior à maior
--     versão remota conhecida.
--
-- REVISÃO DE SEGURANÇA (Etapa 2A, revisão 1) — reescrita da função em
-- relação à primeira versão:
--
-- A primeira versão confiava em p_assignment_id / p_window_start /
-- p_window_end / p_trial_total_seconds calculados em TypeScript
-- (plan-entitlements-service.ts) e apenas passados para a função. Como esta
-- função é a ÚNICA barreira atômica que impede duas sessões concorrentes de
-- autorizarem juntas mais que o saldo do trial, ela nunca deveria confiar em
-- nenhum valor que não possa reverificar sozinha. A função agora RESOLVE
-- tudo isso server-side, a partir de admin_resolve_effective_plan_v1 — nunca
-- aceita assignment_id, janela ou total como parâmetro.
--
-- AUDITORIA DO MODELO DE AUTENTICAÇÃO (Etapa 2A, revisão 2) — confirmada por
-- leitura da implementação vigente de admin_resolve_effective_plan_v1
-- (linha ~6839 do baseline), NENHUMA escrita:
--
--   • Ela NÃO exige que auth.uid() seja administrador. NÃO consulta
--     admin_users, NÃO verifica role nem nenhuma tabela de permissão. O
--     prefixo "admin_" no nome é histórico (função originalmente também
--     usada pelo painel administrativo do ingles-dashboad para resolver o
--     plano de QUALQUER usuário) — não é um gate administrativo.
--   • A única verificação de autorização dentro dela é:
--       IF auth.uid() IS NOT NULL AND auth.uid() IS DISTINCT FROM p_user_id
--         THEN RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
--     ou seja: passa quando auth.uid() é NULL (contexto service_role) OU
--     quando auth.uid() = p_user_id (sessão de usuário lendo o PRÓPRIO
--     plano). Bloqueia apenas leitura cross-user por uma sessão de usuário
--     final autenticada.
--   • GRANT EXECUTE existente nela (migration do ingles, não desta): TO
--     authenticated, TO postgres, TO service_role (não há grant para anon).
--     Isso significa que um usuário final autenticado JÁ PODE chamá-la
--     diretamente hoje, mas apenas para o PRÓPRIO p_user_id — nunca para
--     outro. Este comportamento é pré-existente e correto; não é alterado
--     nem enfraquecido por esta migration.
--   • Ela PERMITE chamada interna por outra função SECURITY DEFINER: o
--     GUC request.jwt.claims (de onde auth.uid() lê) é de escopo de
--     sessão/conexão, não trocado pela troca de privilégio de um SECURITY
--     DEFINER — uma função chamada internamente por outra continua vendo o
--     MESMO auth.uid() da conexão real.
--   • Caminho real desta migration: authorize_trial_conversation_session_v1
--     é chamada exclusivamente via getSharedServiceClient() (o cliente
--     service_role do backend, nunca o cliente do usuário) — a conexão
--     PostgREST autentica com o JWT de service_role (sem claim "sub"), logo
--     auth.uid() = NULL nesse caminho. current_user/session_user tornam-se
--     o dono da função (SECURITY DEFINER) para fins de checagem de
--     privilégio de tabela; JWT role = service_role. A chamada aninhada a
--     admin_resolve_effective_plan_v1(p_user_id, now()) portanto passa
--     incondicionalmente (auth.uid() IS NULL), qualquer que seja p_user_id
--     — o que é seguro porque p_user_id em si já vem de
--     api/_auth.ts:requireAuth() (nunca do corpo da requisição do cliente),
--     e porque authorize_trial_conversation_session_v1's own grants (ver
--     fim do arquivo) NUNCA incluem authenticated/anon — só quem já passou
--     por requireAuth no backend consegue influenciar qual p_user_id é
--     usado, e mesmo assim só o PRÓPRIO.
--   • A chamada atual FUNCIONARIA no Postgres real (sem erro de
--     autorização) — não haveria RAISE EXCEPTION 'not authorized' neste
--     caminho.
--
-- MODELO DE AUTENTICAÇÃO ESCOLHIDO: Modelo B (backend com service role) —
-- o mesmo padrão já usado por TODO o resto de api/conversation/[...slug].ts
-- e por plan-entitlements-service.ts/api/_ai-gateway/entitlements.ts para
-- chamar esta mesma admin_resolve_effective_plan_v1. Nunca modelo A (JWT do
-- usuário): a função não é chamada com o client autenticado do usuário, é
-- chamada pelo backend com o client de service role, com p_user_id
-- derivado exclusivamente da sessão já validada por requireAuth. Optamos
-- por REUTILIZAR admin_resolve_effective_plan_v1 (opção 1 das alternativas
-- avaliadas) em vez de extrair uma segunda função de resolução: a auditoria
-- acima confirma que ela NÃO tem gate administrativo real, então duplicar
-- sua lógica de resolução (pinned vs follow_current_published, janela,
-- suspensão, fallback padrão) criaria uma segunda implementação que poderia
-- divergir da canônica com o tempo — exatamente o risco que reutilizá-la
-- evita. A ordem de resolução (suspensão → assignment ativo/agendado na
-- janela → versão pinned/publicada → fallback padrão) é preservada
-- integralmente, sem nenhuma alteração.
--
--   * plan_code deve ser exatamente 'trial' — rejeita qualquer outro plano
--     (inclusive se um bug de chamada tentar usar esta função para o saldo
--     mensal comercial);
--   * assignment_id e starts_at devem ser não-nulos — rejeita o plano
--     padrão/fallback com code='trial' sem atribuição real;
--   * a janela [starts_at, ends_at) já vem pré-validada por
--     admin_resolve_effective_plan_v1 (seu próprio WHERE já exige
--     starts_at <= now() < COALESCE(ends_at, infinito)) — um trial expirado
--     simplesmente nunca é retornado por ele, então não existe um branch
--     "expirado" separado para esquecer de tratar;
--   * conversation.realtime.seconds.trial_total /
--     .trial_total.unlimited são lidos de plan_capability_values usando o
--     plan_version_id resolvido — nunca um número vindo do chamador.
--
-- IDEMPOTÊNCIA (Etapa 2B — escopo corrigido para incluir assignment_id):
-- a revisão anterior usava unicidade composta (user_id, idempotency_key),
-- que sozinha NÃO distingue duas atribuições diferentes do MESMO usuário
-- (ex.: um trial encerrado e uma concessão posterior, comercial ou um novo
-- trial). Corrigido: nova coluna nullable assignment_id (NULL para toda
-- linha comercial antiga — nenhuma mudança de comportamento para elas) +
-- índice único composto (user_id, assignment_id, idempotency_key). Isso
-- exige que a função RESOLVA o plano (e, portanto, o assignment_id atual)
-- ANTES de fazer qualquer busca de idempotência — não depois, como na
-- revisão anterior — porque a busca agora precisa do assignment_id atual
-- para filtrar corretamente. Efeito em cada cenário:
--   • mesma chave + mesmo usuário + MESMO assignment (retry genuíno da
--     mesma tentativa) → a busca (user_id, assignment_id atual,
--     idempotency_key) encontra a linha já existente → retorna a MESMA
--     autorização, nenhuma nova reserva de saldo.
--   • mesma chave + mesmo usuário + assignment DIFERENTE (trial anterior
--     encerrado/substituído; ex.: uma nova concessão de trial reutilizando
--     por acidente uma chave antiga) → a busca usa o assignment_id ATUAL
--     resolvido agora, que é diferente do assignment_id gravado na linha
--     antiga → NÃO encontra a linha antiga → prossegue para uma
--     autorização NOVA e genuína contra o saldo do assignment ATUAL; a
--     linha antiga nunca é tocada nem reutilizada.
--   • mesma chave + usuário DIFERENTE → a busca já filtra por
--     user_id = p_user_id → nunca encontra nem revela a linha de outro
--     usuário, mesmo que a string da chave coincida por acaso.
--   • autorização antiga fora da janela do assignment atual → nunca é
--     retornada: ela não pertence ao assignment_id atualmente resolvido, e
--     o cálculo de consumo em si também já é limitado à janela
--     [v_plan.starts_at, v_plan.ends_at) do assignment ATUAL.
--
-- CONCORRÊNCIA (item 9): pg_advisory_xact_lock chaveado por p_user_id (um
-- usuário só tem uma atribuição ativa por vez, então lock por usuário
-- equivale a lock por atribuição) serializa recálculo de consumo + inserção
-- da autorização — nenhuma arquitetura paralela, mesma tabela
-- conversation_session_authorizations. Aplicável exclusivamente à sessão
-- inicial de um usuário em trial — planos comerciais continuam usando
-- exatamente o caminho atual (INSERT direto em
-- api/conversation/[...slug].ts), sem nenhuma alteração de comportamento.
--
-- AUTORIZAÇÕES ABANDONADAS (item 6): reaproveita o mecanismo de expiração já
-- existente e plan-agnostic — handleConversationSweep (api/internal/
-- listening/[...slug].ts), que fecha qualquer linha 'authorized' cujo
-- authorized_at + authorized_max_seconds + grace já passou, MESMO sem
-- distinguir plano. Nenhuma alteração necessária nele. Uma falha ANTES da
-- chamada à OpenAI é liberada imediatamente por
-- releaseTrialConversationSessionAuthorization (DELETE), sem esperar o
-- sweep — ver api/_entitlements/authorize-trial-conversation-session.ts.
-- =============================================================================

-- ── Idempotência: extensão mínima e aditiva na tabela existente ────────────
ALTER TABLE public.conversation_session_authorizations
  ADD COLUMN IF NOT EXISTS idempotency_key text;

ALTER TABLE public.conversation_session_authorizations
  ADD COLUMN IF NOT EXISTS assignment_id uuid REFERENCES public.user_plan_assignments(id);

-- Índices anteriores desta mesma Etapa (nunca aplicados em nenhum
-- ambiente) removidos em favor do índice composto final abaixo.
DROP INDEX IF EXISTS public.uq_conversation_session_authorizations_idempotency_key;
DROP INDEX IF EXISTS public.uq_conversation_session_authorizations_user_idempotency_key;

-- Único índice composto (nunca global): a mesma chave textual só colide se
-- pertencer ao MESMO usuário E à MESMA atribuição — ver "IDEMPOTÊNCIA"
-- acima. Linhas comerciais antigas (assignment_id/idempotency_key ambos
-- NULL) nunca participam desta constraint.
CREATE UNIQUE INDEX IF NOT EXISTS uq_conversation_session_authorizations_user_assignment_idempotency_key
  ON public.conversation_session_authorizations (user_id, assignment_id, idempotency_key)
  WHERE assignment_id IS NOT NULL AND idempotency_key IS NOT NULL;

CREATE OR REPLACE FUNCTION public.authorize_trial_conversation_session_v1(
  p_user_id uuid,
  p_requested_max_seconds integer,
  p_session_date date,
  p_gateway_budget_reservation_id uuid,
  p_gateway_session_id uuid,
  p_idempotency_key text
)
RETURNS TABLE(authorization_id uuid, authorized_max_seconds integer, blocked boolean, blocked_reason text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_existing_id  uuid;
  v_existing_max integer;
  v_plan         RECORD;
  v_base_value   jsonb;
  v_unlimited_value jsonb;
  v_unlimited    boolean;
  v_trial_total  numeric;
  v_consumed     numeric;
  v_remaining    numeric;
  v_authorized   integer;
  v_id           uuid;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'user_id is required';
  END IF;
  IF p_session_date IS NULL THEN
    RAISE EXCEPTION 'session_date is required';
  END IF;
  IF p_idempotency_key IS NULL OR char_length(p_idempotency_key) = 0 THEN
    RAISE EXCEPTION 'idempotency_key is required';
  END IF;

  -- Server-side re-derivation of the CURRENT effective plan/assignment for
  -- p_user_id — never trusts a caller-supplied assignment_id, window, or
  -- trial total. Reuses the exact canonical resolver every other
  -- entitlement read in this app already uses (see the migration's
  -- "AUDITORIA DO MODELO DE AUTENTICAÇÃO" comment for why calling it here,
  -- via the service-role context this function always runs in, is safe).
  -- Resolved BEFORE any idempotency lookup (Etapa 2B correction): the
  -- lookup itself needs the CURRENT assignment_id to scope correctly.
  SELECT * INTO v_plan FROM public.admin_resolve_effective_plan_v1(p_user_id, now());

  IF NOT FOUND
     OR NOT v_plan.access_allowed
     OR v_plan.plan_code IS DISTINCT FROM 'trial'
     OR v_plan.assignment_id IS NULL
     OR v_plan.starts_at IS NULL
     OR v_plan.plan_version_id IS NULL
  THEN
    -- Covers, uniformly: no resolvable plan; suspended user; resolved to
    -- any OTHER plan (this function must never authorize a commercial
    -- balance); the trial-coded plan reached via the default/fallback plan
    -- with no real assignment (assignment_id/starts_at null). An EXPIRED
    -- trial assignment also lands here: admin_resolve_effective_plan_v1's
    -- own WHERE clause already requires
    -- starts_at <= now() < COALESCE(ends_at, infinity) for an
    -- assignment-backed row, so an expired assignment is never returned by
    -- it at all — there is no separate "expired" branch to forget. An old
    -- authorization tied to a now-replaced/expired assignment is therefore
    -- never reachable via any idempotency lookup below either, since none
    -- of them ever run with a stale assignment_id.
    RETURN QUERY SELECT NULL::uuid, 0, true, 'no_active_trial'::text;
    RETURN;
  END IF;

  -- Idempotency — outside the lock, cheap early return for the common case
  -- (a genuine repeat of an already-decided attempt for the SAME user AND
  -- the SAME currently-active assignment). A row tied to a DIFFERENT
  -- assignment_id (including an older, now-replaced trial assignment) is
  -- structurally excluded by this filter — it is never reused, matching
  -- "mesma chave e mesmo usuário, mas assignment diferente → não reutiliza
  -- a autorização anterior".
  SELECT id, authorized_max_seconds INTO v_existing_id, v_existing_max
  FROM public.conversation_session_authorizations
  WHERE user_id = p_user_id AND assignment_id = v_plan.assignment_id AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    RETURN QUERY SELECT v_existing_id, v_existing_max, false, NULL::text;
    RETURN;
  END IF;

  IF p_requested_max_seconds IS NULL OR p_requested_max_seconds <= 0 THEN
    RETURN QUERY SELECT NULL::uuid, 0, true, 'invalid_request'::text;
    RETURN;
  END IF;

  -- Serializes concurrent authorization attempts for the SAME user. A user
  -- can have at most one active/scheduled assignment at a time (enforced by
  -- admin_assign_plan_v1's own overlap check in ingles-dashboad), so locking
  -- by user_id is equivalent to locking by assignment.
  PERFORM pg_advisory_xact_lock(hashtext('trial_conversation_balance'), hashtext(p_user_id::text));

  -- Re-check idempotency INSIDE the lock (same composite scope: user_id +
  -- CURRENT assignment_id + key): a second concurrent call with the SAME
  -- key for the SAME user AND assignment that arrived between the check
  -- above and acquiring the lock must still be caught here, never
  -- double-inserted.
  SELECT id, authorized_max_seconds INTO v_existing_id, v_existing_max
  FROM public.conversation_session_authorizations
  WHERE user_id = p_user_id AND assignment_id = v_plan.assignment_id AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    RETURN QUERY SELECT v_existing_id, v_existing_max, false, NULL::text;
    RETURN;
  END IF;

  -- Resolve trial_total/trial_total.unlimited SERVER-SIDE from the resolved
  -- plan_version — never a number computed by the TypeScript caller.
  SELECT value INTO v_base_value FROM public.plan_capability_values
  WHERE plan_version_id = v_plan.plan_version_id AND capability_key = 'conversation.realtime.seconds.trial_total';
  SELECT value INTO v_unlimited_value FROM public.plan_capability_values
  WHERE plan_version_id = v_plan.plan_version_id AND capability_key = 'conversation.realtime.seconds.trial_total.unlimited';

  v_unlimited := COALESCE(v_unlimited_value = 'true'::jsonb, false);

  IF NOT v_unlimited AND v_base_value IS NULL THEN
    -- Missing configuration on an already-published trial version is a
    -- config bug (publish_plan_version's own completeness check should
    -- have refused to publish it) — never silently treated as unlimited,
    -- never a fallback to the monthly pair.
    RETURN QUERY SELECT NULL::uuid, 0, true, 'no_active_trial'::text;
    RETURN;
  END IF;

  IF v_unlimited THEN
    -- Nothing to protect on the seconds dimension — authorize the
    -- requested ceiling outright (the technical/per-turn ceilings are
    -- still enforced by the caller; this function only guards the
    -- lifetime SECONDS balance).
    BEGIN
      INSERT INTO public.conversation_session_authorizations (
        user_id, session_date, authorized_max_seconds,
        gateway_budget_reservation_id, gateway_session_id, idempotency_key, assignment_id
      ) VALUES (
        p_user_id, p_session_date, p_requested_max_seconds,
        p_gateway_budget_reservation_id, p_gateway_session_id, p_idempotency_key, v_plan.assignment_id
      )
      RETURNING id INTO v_id;
    EXCEPTION WHEN unique_violation THEN
      SELECT id, authorized_max_seconds INTO v_id, v_authorized
      FROM public.conversation_session_authorizations
      WHERE user_id = p_user_id AND assignment_id = v_plan.assignment_id AND idempotency_key = p_idempotency_key;
      RETURN QUERY SELECT v_id, v_authorized, false, NULL::text;
      RETURN;
    END;
    RETURN QUERY SELECT v_id, p_requested_max_seconds, false, NULL::text;
    RETURN;
  END IF;

  v_trial_total := (v_base_value)::text::numeric;

  -- Same accounting rule as plan-entitlements-service.ts's
  -- conversationSecondsConsumed: a completed row counts its recorded
  -- duration; a still-'authorized' (in-progress) row counts its live
  -- elapsed time, clamped to what it was authorized for — so a
  -- currently-running session correctly reduces what a NEW request may
  -- start with, even before it reports its own completion. Bounded by the
  -- SERVER-resolved assignment window, never a caller-supplied one — an
  -- authorization from a DIFFERENT (older) assignment can never contribute
  -- to this sum either, since its authorized_at necessarily falls outside
  -- [v_plan.starts_at, v_plan.ends_at) for the CURRENT assignment.
  SELECT COALESCE(SUM(
    CASE
      WHEN status = 'completed' THEN COALESCE(duration_seconds, 0)
      ELSE LEAST(GREATEST(EXTRACT(EPOCH FROM (now() - authorized_at)), 0), authorized_max_seconds)
    END
  ), 0)
  INTO v_consumed
  FROM public.conversation_session_authorizations
  WHERE user_id = p_user_id
    AND authorized_at >= v_plan.starts_at
    AND authorized_at < COALESCE(v_plan.ends_at, 'infinity'::timestamptz);

  v_remaining := GREATEST(v_trial_total - v_consumed, 0);

  IF v_remaining <= 0 THEN
    RETURN QUERY SELECT NULL::uuid, 0, true, 'balance_exhausted'::text;
    RETURN;
  END IF;

  v_authorized := LEAST(p_requested_max_seconds, FLOOR(v_remaining)::integer);
  IF v_authorized <= 0 THEN
    RETURN QUERY SELECT NULL::uuid, 0, true, 'balance_exhausted'::text;
    RETURN;
  END IF;

  BEGIN
    INSERT INTO public.conversation_session_authorizations (
      user_id, session_date, authorized_max_seconds,
      gateway_budget_reservation_id, gateway_session_id, idempotency_key, assignment_id
    ) VALUES (
      p_user_id, p_session_date, v_authorized,
      p_gateway_budget_reservation_id, p_gateway_session_id, p_idempotency_key, v_plan.assignment_id
    )
    RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    -- The same (user_id, assignment_id, idempotency_key) raced in between
    -- the check above and this INSERT (structurally prevented by the
    -- advisory lock in normal operation — the unique index is the final,
    -- unconditional guarantee regardless) — return the row that won
    -- instead of erroring.
    SELECT id, authorized_max_seconds INTO v_id, v_authorized
    FROM public.conversation_session_authorizations
    WHERE user_id = p_user_id AND assignment_id = v_plan.assignment_id AND idempotency_key = p_idempotency_key;
    RETURN QUERY SELECT v_id, v_authorized, false, NULL::text;
    RETURN;
  END;

  RETURN QUERY SELECT v_id, v_authorized, false, NULL::text;
END;
$function$;

REVOKE ALL ON FUNCTION public.authorize_trial_conversation_session_v1(uuid, integer, date, uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.authorize_trial_conversation_session_v1(uuid, integer, date, uuid, uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.authorize_trial_conversation_session_v1(uuid, integer, date, uuid, uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.authorize_trial_conversation_session_v1(uuid, integer, date, uuid, uuid, text) TO postgres;
GRANT EXECUTE ON FUNCTION public.authorize_trial_conversation_session_v1(uuid, integer, date, uuid, uuid, text) TO service_role;
