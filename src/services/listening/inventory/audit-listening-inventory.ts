import type { SupabaseClient } from '@supabase/supabase-js';
import { getListeningInventoryStatus } from './get-listening-inventory-status';
import { INVENTORY_CONFIG } from '../jobs/listening-job-config';

export type AuditListeningInventoryResult = {
  alertsCreated: number;
  issues:        string[];
};

export async function auditListeningInventory(
  supabase: SupabaseClient,
): Promise<AuditListeningInventoryResult> {
  const inventoryStatus = await getListeningInventoryStatus(supabase);
  const issues: string[] = [];
  const alerts: Array<{
    alert_type:  string;
    severity:    string;
    message:     string;
    details:     Record<string, unknown>;
    episode_id?: string;
    job_id?:     string;
  }> = [];

  // ── Check inventory levels ────────────────────────────────────────────────
  for (const levelStatus of inventoryStatus) {
    if (levelStatus.status === 'empty' && levelStatus.activeUserCount > 0) {
      const msg = `Level ${levelStatus.cefrLevel} has NO published episodes available`;
      issues.push(msg);
      alerts.push({
        alert_type: 'inventory_empty',
        severity:   'critical',
        message:    msg,
        details:    { cefrLevel: levelStatus.cefrLevel, activeUserCount: levelStatus.activeUserCount },
      });
    } else if (levelStatus.status === 'critical') {
      const msg = `Level ${levelStatus.cefrLevel} is below minimum (${levelStatus.publishedAvailable}/${INVENTORY_CONFIG.MINIMUM_PER_LEVEL})`;
      issues.push(msg);
      alerts.push({
        alert_type: 'inventory_critical',
        severity:   'error',
        message:    msg,
        details:    { cefrLevel: levelStatus.cefrLevel, published: levelStatus.publishedAvailable },
      });
    } else if (levelStatus.status === 'low') {
      const msg = `Level ${levelStatus.cefrLevel} is below desired (${levelStatus.publishedAvailable}/${INVENTORY_CONFIG.DESIRED_PER_LEVEL})`;
      issues.push(msg);
      alerts.push({
        alert_type: 'inventory_low',
        severity:   'warning',
        message:    msg,
        details:    { cefrLevel: levelStatus.cefrLevel, published: levelStatus.publishedAvailable },
      });
    }
  }

  // ── Dead letter jobs ──────────────────────────────────────────────────────
  const { data: deadLetters } = await supabase
    .from('listening_jobs')
    .select('id, job_type, episode_id, cefr_level, error_message')
    .eq('status', 'dead_letter')
    .order('created_at', { ascending: false })
    .limit(20);

  for (const dl of deadLetters ?? []) {
    const msg = `Dead letter job: ${dl.job_type} for episode ${dl.episode_id ?? 'N/A'}`;
    issues.push(msg);
    alerts.push({
      alert_type: 'dead_letter_job',
      severity:   'error',
      message:    msg,
      job_id:     dl.id,
      episode_id: dl.episode_id ?? undefined,
      details:    {
        jobType:      dl.job_type,
        cefrLevel:    dl.cefr_level,
        errorMessage: dl.error_message,
      },
    });
  }

  // ── Stale pipelines (episode in pipeline > 24h with no recent job activity) ──
  const staleDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: staleEpisodes } = await supabase
    .from('listening_episodes')
    .select('id, status, cefr_level, created_at')
    .not('status', 'in', '("published","archived","failed")')
    .lt('created_at', staleDate)
    .limit(10);

  for (const ep of staleEpisodes ?? []) {
    // Check if there are active jobs for this episode
    const { data: activeJobs } = await supabase
      .from('listening_jobs')
      .select('id')
      .eq('episode_id', ep.id)
      .in('status', ['pending', 'processing', 'retry'])
      .limit(1);

    if (!activeJobs || activeJobs.length === 0) {
      const msg = `Episode ${ep.id} (${ep.cefr_level}) stuck in status "${ep.status}" for >24h with no active jobs`;
      issues.push(msg);
      alerts.push({
        alert_type: 'stale_pipeline',
        severity:   'warning',
        message:    msg,
        episode_id: ep.id,
        details:    { status: ep.status, cefrLevel: ep.cefr_level, createdAt: ep.created_at },
      });
    }
  }

  // ── Insert alerts (dedup: don't insert same alert_type+episode_id if open) ──
  let alertsCreated = 0;
  for (const alert of alerts) {
    // Check for existing open alert of same type
    const { data: existing } = await supabase
      .from('listening_operational_alerts')
      .select('id')
      .eq('alert_type', alert.alert_type)
      .eq('status', 'open')
      .eq('episode_id', alert.episode_id ?? null)
      .limit(1)
      .maybeSingle();

    if (!existing) {
      await supabase.from('listening_operational_alerts').insert({
        alert_type:  alert.alert_type,
        severity:    alert.severity,
        message:     alert.message,
        details:     alert.details,
        episode_id:  alert.episode_id ?? null,
        job_id:      alert.job_id ?? null,
        status:      'open',
      });
      alertsCreated++;
    }
  }

  console.error(JSON.stringify({
    event:         'listening_inventory_checked',
    issueCount:    issues.length,
    alertsCreated,
    t: Date.now(),
  }));

  return { alertsCreated, issues };
}
