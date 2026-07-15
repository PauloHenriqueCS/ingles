/**
 * GET /api/internal/listening/storage-audit
 *
 * Cron endpoint — fires once weekly (08:00 UTC Sunday).
 * Audits storage consistency (missing files, orphaned files, hash mismatches).
 * Protected by Authorization: Bearer {CRON_SECRET}.
 */

import { checkCronAuth } from '../_auth';
import { methodGuard, safeLog } from '../../_helpers';
import { auditListeningStorageConsistency } from '../../../src/services/listening/publication/audit-listening-storage';

export default async function handler(req: any, res: any): Promise<void> {
  if (!methodGuard(req, res, ['GET'])) return;

  if (!checkCronAuth(req)) {
    safeLog('internal/listening/storage-audit', 'unauthorized', 401, {});
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const result = await auditListeningStorageConsistency();

    safeLog('internal/listening/storage-audit', 'storage_audit_completed', 200, {
      totalIssues: result.summary.totalIssues,
    });

    return res.status(200).json({
      auditedAt:   result.auditedAt,
      totalIssues: result.summary.totalIssues,
      summary:     result.summary,
      issues:      result.issues.slice(0, 50), // cap response size
    });
  } catch (err) {
    safeLog('internal/listening/storage-audit', 'storage_audit_error', 500, {
      error: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({ error: 'Storage audit error' });
  }
}
