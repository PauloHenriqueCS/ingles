/**
 * SERVER-ONLY: Repositório para writing_diagnostic_missions.
 * Nunca importar em código client-side (src/).
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';

// ── Service role client (write access a writing_diagnostic_missions) ───────

function createServiceClient(): SupabaseClient {
  const url = process.env.VITE_SUPABASE_URL ?? '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  return createClient(url, key);
}

// ── Tipos locais (espelham o schema SQL) ──────────────────────────────────────

export interface DiagnosticMissionRow {
  id: string;
  user_id: string;
  theme_id: string | null;
  diagnostic_sequence: 1 | 2;
  catalog_version: number;
  diagnostic_plan: Record<string, unknown>;
  objective_ids: string[];
  status: 'generated' | 'superseded' | 'completed';
  regeneration_count: number;
  rejection_log: Array<{
    attempt: number;
    rejectionCode: string;
    rejectionDetail: string;
    timestamp: string;
  }>;
  prompt_version: string;
  validator_version: string;
  accepted_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

// ── Leitura ───────────────────────────────────────────────────────────────────

/**
 * Retorna todas as missões diagnósticas ativas (não superseded) do usuário.
 * Usa o cliente do usuário (leitura via RLS).
 */
export async function getActiveDiagnosticMissions(
  supabase: SupabaseClient,
  userId: string,
): Promise<DiagnosticMissionRow[]> {
  const { data, error } = await supabase
    .from('writing_diagnostic_missions')
    .select('*')
    .eq('user_id', userId)
    .neq('status', 'superseded')
    .order('diagnostic_sequence', { ascending: true });

  if (error) {
    console.error('[diagnostic-repository] getActiveDiagnosticMissions error:', error.code);
    return [];
  }
  return (data ?? []) as DiagnosticMissionRow[];
}

/**
 * Busca missão diagnóstica ativa por theme_id.
 * Usada para vincular ao tema quando o usuário aceita ou completa.
 */
export async function getDiagnosticMissionByThemeId(
  supabase: SupabaseClient,
  themeId: string,
  userId: string,
): Promise<DiagnosticMissionRow | null> {
  const { data, error } = await supabase
    .from('writing_diagnostic_missions')
    .select('*')
    .eq('theme_id', themeId)
    .eq('user_id', userId)
    .neq('status', 'superseded')
    .maybeSingle();

  if (error) {
    console.error('[diagnostic-repository] getDiagnosticMissionByThemeId error:', error.code);
    return null;
  }
  return (data ?? null) as DiagnosticMissionRow | null;
}

// ── Escrita (service role) ────────────────────────────────────────────────────

export interface InsertDiagnosticMissionParams {
  userId: string;
  themeId: string;
  diagnosticSequence: 1 | 2;
  catalogVersion: number;
  diagnosticPlan: Record<string, unknown>;
  objectiveIds: string[];
  rejectionLog: Array<{
    attempt: number;
    rejectionCode: string;
    rejectionDetail: string;
    timestamp: string;
  }>;
  promptVersion: string;
  validatorVersion: string;
}

/**
 * Insere um novo registro de missão diagnóstica.
 * Usa service role — o usuário não tem permissão de INSERT direta.
 *
 * Se houver conflito no índice único (user_id, diagnostic_sequence)
 * com status != 'superseded', retorna null (idempotência — missão já existe).
 */
export async function insertDiagnosticMission(
  params: InsertDiagnosticMissionParams,
): Promise<DiagnosticMissionRow | null> {
  const serviceClient = createServiceClient();

  const { data, error } = await serviceClient
    .from('writing_diagnostic_missions')
    .insert({
      user_id: params.userId,
      theme_id: params.themeId,
      diagnostic_sequence: params.diagnosticSequence,
      catalog_version: params.catalogVersion,
      diagnostic_plan: params.diagnosticPlan,
      objective_ids: params.objectiveIds,
      status: 'generated',
      regeneration_count: 0,
      rejection_log: params.rejectionLog,
      prompt_version: params.promptVersion,
      validator_version: params.validatorVersion,
    })
    .select()
    .single();

  if (error) {
    // Código 23505 = unique_violation — missão já existe para esta sequência
    if (error.code === '23505') {
      return null;
    }
    console.error('[diagnostic-repository] insertDiagnosticMission error:', error.code);
    return null;
  }
  return data as DiagnosticMissionRow;
}

/**
 * Marca missões diagnósticas de uma sequência como 'superseded'.
 * Chamado antes de inserir a missão substituta ("Gerar outro tema").
 */
export async function supersedeActiveDiagnosticMissions(
  userId: string,
  diagnosticSequence: 1 | 2,
): Promise<boolean> {
  const serviceClient = createServiceClient();

  const { error } = await serviceClient
    .from('writing_diagnostic_missions')
    .update({
      status: 'superseded',
      updated_at: new Date().toISOString(),
    })
    .eq('user_id', userId)
    .eq('diagnostic_sequence', diagnosticSequence)
    .neq('status', 'superseded');

  if (error) {
    console.error('[diagnostic-repository] supersedeActiveDiagnosticMissions error:', error.code);
    return false;
  }
  return true;
}

/**
 * Marca uma missão diagnóstica como aceita (usuário começou a escrever).
 * Após aceita, os objetivos ficam congelados — não podem ser substituídos.
 */
export async function markDiagnosticMissionAccepted(
  userId: string,
  themeId: string,
): Promise<boolean> {
  const serviceClient = createServiceClient();

  const { error } = await serviceClient
    .from('writing_diagnostic_missions')
    .update({
      accepted_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('user_id', userId)
    .eq('theme_id', themeId)
    .eq('status', 'generated')
    .is('accepted_at', null);

  if (error) {
    console.error('[diagnostic-repository] markDiagnosticMissionAccepted error:', error.code);
    return false;
  }
  return true;
}

/**
 * Marca uma missão diagnóstica como completada.
 * Chamado quando um texto original elegível é submetido com sucesso.
 */
export async function markDiagnosticMissionCompleted(
  userId: string,
  themeId: string,
): Promise<boolean> {
  const serviceClient = createServiceClient();

  const { error } = await serviceClient
    .from('writing_diagnostic_missions')
    .update({
      status: 'completed',
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('user_id', userId)
    .eq('theme_id', themeId)
    .neq('status', 'superseded');

  if (error) {
    console.error('[diagnostic-repository] markDiagnosticMissionCompleted error:', error.code);
    return false;
  }
  return true;
}

/**
 * Incrementa o contador de regeneração da missão ativa.
 * Chamado quando o usuário clica "Gerar outro tema" durante diagnóstico.
 */
export async function incrementDiagnosticRegenerationCount(
  userId: string,
  diagnosticSequence: 1 | 2,
): Promise<void> {
  const serviceClient = createServiceClient();

  // Fetch current count first (Supabase não suporta incremento direto sem RPC)
  const { data } = await serviceClient
    .from('writing_diagnostic_missions')
    .select('id, regeneration_count')
    .eq('user_id', userId)
    .eq('diagnostic_sequence', diagnosticSequence)
    .neq('status', 'superseded')
    .maybeSingle();

  if (!data) return;

  await serviceClient
    .from('writing_diagnostic_missions')
    .update({
      regeneration_count: (data.regeneration_count ?? 0) + 1,
      updated_at: new Date().toISOString(),
    })
    .eq('id', data.id);
}

// ── Perfil de writing (leitura) ───────────────────────────────────────────────

/**
 * Retorna o perfil de writing do aluno usando o cliente autenticado.
 */
export async function getWritingProfile(
  supabase: SupabaseClient,
  userId: string,
): Promise<{ level: string | null; assessment_status: string } | null> {
  const { data, error } = await supabase
    .from('learner_skill_profiles')
    .select('cefr_level, assessment_status')
    .eq('user_id', userId)
    .eq('skill', 'writing')
    .maybeSingle();

  if (error || !data) return null;
  return {
    level: data.cefr_level ?? null,
    assessment_status: data.assessment_status ?? 'unknown',
  };
}
