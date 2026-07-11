-- DIAS DE PRÁTICA CONFIGURÁVEIS
-- Execute no Supabase SQL Editor

-- =====================================================================
-- 1. Configurações de aprendizado por usuário
-- =====================================================================

create table if not exists public.user_learning_settings (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null unique references auth.users(id) on delete cascade,
  -- Array de dias da semana ativos: 0=Dom, 1=Seg, ..., 6=Sáb
  active_weekdays  jsonb not null default '[1,2,3,4,5]'::jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

alter table public.user_learning_settings enable row level security;

drop policy if exists "uls_all" on public.user_learning_settings;

create policy "uls_all" on public.user_learning_settings
  for all to authenticated
  using  (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- =====================================================================
-- 2. Exceções pontuais: dias inativos que o usuário ativa manualmente
-- =====================================================================

create table if not exists public.learning_day_overrides (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  entry_date   date not null,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  unique (user_id, entry_date)
);

alter table public.learning_day_overrides enable row level security;

drop policy if exists "ldo_all" on public.learning_day_overrides;

create policy "ldo_all" on public.learning_day_overrides
  for all to authenticated
  using  (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- =====================================================================
-- 3. Atualizar apply_review_schedule para ajustar datas aos dias ativos
-- =====================================================================

create or replace function public.apply_review_schedule(p_attempt_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = public, auth
as $$
declare
  v_attempt        record;
  v_group          record;
  v_prev_level     integer;
  v_prev_status    text;
  v_prev_next      timestamptz;
  v_new_level      integer;
  v_new_status     text;
  v_new_next       timestamptz;
  v_interval_days  integer;
  v_weekdays       integer[];
  v_candidate      timestamptz;
  v_iter           integer;
begin
  -- Carregar e verificar a tentativa (RLS garante user_id = auth.uid())
  select * into v_attempt
  from public.review_attempts
  where id = p_attempt_id and user_id = auth.uid();

  if not found then
    raise exception 'Tentativa não encontrada ou não autorizada';
  end if;

  -- Bloquear o grupo para evitar processamento simultâneo
  select * into v_group
  from public.review_groups
  where id = v_attempt.review_group_id and user_id = auth.uid()
  for update;

  if not found then
    raise exception 'Grupo de revisão não encontrado ou não autorizado';
  end if;

  -- Idempotência: verificar se esta tentativa já foi processada (após o lock)
  if exists (
    select 1 from public.review_schedule_history
    where review_attempt_id = p_attempt_id
  ) then
    return jsonb_build_object('skipped', true, 'reason', 'already_processed');
  end if;

  -- Grupo já dominado: não alterar
  if v_group.status = 'mastered' or v_group.review_level >= 4 then
    return jsonb_build_object('skipped', true, 'reason', 'already_mastered');
  end if;

  v_prev_level  := v_group.review_level;
  v_prev_status := v_group.status;
  v_prev_next   := v_group.next_review_at;

  -- Carregar dias ativos do usuário (fallback: seg-sex)
  select array(select jsonb_array_elements_text(active_weekdays)::integer)
  into v_weekdays
  from public.user_learning_settings
  where user_id = auth.uid();

  if v_weekdays is null or array_length(v_weekdays, 1) = 0 then
    v_weekdays := array[1,2,3,4,5];
  end if;

  -- Calcular novo agendamento (lógica determinística, em UTC)
  if v_attempt.overall_result = 'passed' then
    case v_group.review_level
      when 0 then
        v_new_level := 1; v_interval_days := 7;
        v_new_next  := (now() at time zone 'utc') + interval '7 days';
        v_new_status := 'scheduled';
      when 1 then
        v_new_level := 2; v_interval_days := 21;
        v_new_next  := (now() at time zone 'utc') + interval '21 days';
        v_new_status := 'scheduled';
      when 2 then
        v_new_level := 3; v_interval_days := 60;
        v_new_next  := (now() at time zone 'utc') + interval '60 days';
        v_new_status := 'scheduled';
      when 3 then
        v_new_level := 4; v_interval_days := null;
        v_new_next  := null;
        v_new_status := 'mastered';
      else
        return jsonb_build_object('skipped', true, 'reason', 'already_mastered');
    end case;
  else
    -- failed: redefinir para nível 0, revisão em 2 dias
    v_new_level := 0; v_interval_days := 2;
    v_new_next  := (now() at time zone 'utc') + interval '2 days';
    v_new_status := 'scheduled';
  end if;

  -- Ajustar next_review_at ao próximo dia ativo
  if v_new_next is not null then
    v_candidate := v_new_next;
    v_iter := 0;
    while not (extract(dow from v_candidate)::integer = any(v_weekdays)) and v_iter < 8 loop
      v_candidate := v_candidate + interval '1 day';
      v_iter := v_iter + 1;
    end loop;
    v_new_next := v_candidate;
  end if;

  -- Atualizar grupo (proteção extra: só aplica se nível não mudou desde o lock)
  update public.review_groups
  set
    review_level   = v_new_level,
    status         = v_new_status,
    next_review_at = v_new_next,
    updated_at     = now()
  where id = v_group.id
    and review_level = v_prev_level;

  if not found then
    return jsonb_build_object('skipped', true, 'reason', 'concurrent_update');
  end if;

  -- Registrar histórico do ciclo
  insert into public.review_schedule_history (
    user_id, review_group_id, review_attempt_id,
    previous_level, new_level, overall_result,
    previous_status, new_status,
    previous_next_review_at, new_next_review_at
  ) values (
    auth.uid(), v_group.id, p_attempt_id,
    v_prev_level, v_new_level, v_attempt.overall_result,
    v_prev_status, v_new_status,
    v_prev_next, v_new_next
  );

  return jsonb_build_object(
    'applied',       true,
    'newLevel',      v_new_level,
    'newStatus',     v_new_status,
    'nextReviewAt',  v_new_next,
    'intervalDays',  v_interval_days,
    'overallResult', v_attempt.overall_result
  );
end;
$$;
