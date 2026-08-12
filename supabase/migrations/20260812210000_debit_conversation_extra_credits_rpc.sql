-- =============================================================================
-- MIGRATION: 20260812210000_debit_conversation_extra_credits_rpc
-- Projeto: Lemon
--
-- Aplicada automaticamente por .github/workflows/deploy-production.yml
-- (supabase db push) após o merge na main, e por homologation.yml em develop.
-- NÃO aplicar manualmente no SQL Editor nem via apply_migration (MCP) — ver
-- supabase/MIGRATIONS.md. Idempotente (IF NOT EXISTS / CREATE OR REPLACE):
-- não modifica nem remove dados existentes.
--
-- Débito dos créditos de minutos de conversação comprados
-- (user_conversation_credits) quando uma sessão consome segundos ALÉM dos
-- minutos incluídos no plano. Antes desta migration os créditos comprados eram
-- creditados/somados/exibidos mas NUNCA debitados. O débito é chamado dos dois
-- pontos de finalização de sessão (handleSessionComplete e a varredura de
-- sessões abandonadas) por esta RPC atômica. Ordem de consumo (regra já
-- existente): minutos do plano primeiro, créditos comprados depois — só a
-- porção ALÉM do plano é debitada.
-- =============================================================================

-- Marcador de idempotência: o débito de uma autorização roda no máximo uma vez.
alter table public.conversation_session_authorizations
  add column if not exists extra_credits_debited_at timestamptz null;

create or replace function public.debit_conversation_extra_credits_v1(
  p_user_id uuid,
  p_authorization_id uuid,
  p_plan_limit_seconds integer
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_auth record;
  v_month_start date;
  v_month_end date;
  v_consumed_before integer;
  v_in_plan_remaining_before integer;
  v_over_plan integer;
  v_to_debit integer;
  v_cred record;
  v_take integer;
begin
  select id, user_id, status, duration_seconds, session_date, extra_credits_debited_at
    into v_auth
  from public.conversation_session_authorizations
  where id = p_authorization_id and user_id = p_user_id
  for update;

  if not found then return 0; end if;
  if v_auth.extra_credits_debited_at is not null then return 0; end if;
  if v_auth.status <> 'completed' or coalesce(v_auth.duration_seconds, 0) <= 0 then
    return 0;
  end if;

  update public.conversation_session_authorizations
    set extra_credits_debited_at = now()
  where id = p_authorization_id;

  v_month_start := date_trunc('month', v_auth.session_date)::date;
  v_month_end := (v_month_start + interval '1 month')::date;

  select coalesce(sum(duration_seconds), 0)::integer
    into v_consumed_before
  from public.conversation_session_authorizations
  where user_id = p_user_id
    and status = 'completed'
    and id <> p_authorization_id
    and session_date >= v_month_start and session_date < v_month_end;

  v_in_plan_remaining_before := greatest(0, coalesce(p_plan_limit_seconds, 0) - v_consumed_before);
  v_over_plan := greatest(0, v_auth.duration_seconds - v_in_plan_remaining_before);
  if v_over_plan <= 0 then return 0; end if;

  v_to_debit := v_over_plan;
  for v_cred in
    select id, remaining_seconds
    from public.user_conversation_credits
    where user_id = p_user_id
      and remaining_seconds > 0
      and (expires_at is null or expires_at > now())
    order by expires_at asc nulls last, created_at asc
    for update
  loop
    exit when v_to_debit <= 0;
    v_take := least(v_cred.remaining_seconds, v_to_debit);
    update public.user_conversation_credits
      set remaining_seconds = remaining_seconds - v_take
    where id = v_cred.id;
    v_to_debit := v_to_debit - v_take;
  end loop;

  return v_over_plan - v_to_debit;
end;
$$;

revoke all on function public.debit_conversation_extra_credits_v1(uuid, uuid, integer) from public;
revoke all on function public.debit_conversation_extra_credits_v1(uuid, uuid, integer) from anon;
revoke all on function public.debit_conversation_extra_credits_v1(uuid, uuid, integer) from authenticated;
grant execute on function public.debit_conversation_extra_credits_v1(uuid, uuid, integer) to service_role;
grant execute on function public.debit_conversation_extra_credits_v1(uuid, uuid, integer) to postgres;
