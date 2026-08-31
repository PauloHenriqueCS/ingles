# Behavioral Push (streak_risk / abandonment)

Backend-driven, behaviour-triggered push notifications. **Few pushes, but
contextual.** This is a *separate* system from the local "Lembrete de prática"
(`user_practice_reminder_preferences` + `@capacitor/local-notifications`), which
fires 100% on-device and is untouched here.

Two types only (v1):

- **`streak_risk`** — the user has a live streak that today (a configured
  practice day) would break if they don't practice.
- **`abandonment`** — the user has missed ≥ 2 consecutive *configured* practice
  days without completing a valid activity.

Priority when both apply: **streak_risk > abandonment**. Never both. At most
**one** behavioral push per user per day, and a **global 72h cooldown** across
both types (only a genuinely `sent` push starts it).

## Golden rule

> If the user has already completed **any** valid activity today, **no**
> behavioral push is sent that day — even if other activities remain.

Server-authoritative (never client state).

## Canonical sources (reused, not duplicated)

| Concern | Source |
| --- | --- |
| Configured practice days | `user_learning_settings.active_weekdays` (0=Sun..6=Sat). Same set the streak uses. NOT the reminder table. |
| Streak math | `src/lib/metricsCore.ts::computeWeekdayStreak` — imported directly by the sweep. One algorithm, never two. |
| "Practiced today" / active day | UNION of the 6 completion tables (writing `english_reviews`, pronunciation `pronunciation_assessments` + `pronunciation_training_sessions`, listening `user_listening_assignments`, review `review_item_attempts`, conversation `conversation_sessions`). Same definition as `src/lib/activeDates.ts`. |
| Entitlement ("can practice?") | `getCurrentUserPlanEntitlements(userId)` → any of writing/listening/pronunciation/conversation `.enabled`. |
| Interface language | `user_curriculum_preferences.interface_language` (server-side). |
| Exclusions | `user_account_deactivations`, `admin_users`, `user_communication_blocks` (`canSendCommunication`, fail-closed), `REVENUECAT_SANDBOX_TEST_USER_IDS`. |
| Timezone | `America/Sao_Paulo` (fixed UTC-3, no DST). |

Two notions of "conversation counts" are intentionally distinct:
- **Streak / active-date** (matches Home): a conversation day counts only when
  the daily-minutes goal is met.
- **"Practiced today" anti-nag gate** (generous): any completed conversation
  session (duration > 0) suppresses the push. Product decision — avoid nagging
  someone who did a short session.

## Architecture

```
pg_cron (behavioral_push_cron_sweep, 23:00/23:30 UTC ≈ 20:00 SP)
  → pg_net GET /api/internal/listening/behavioral-push-sweep  (Authorization: Bearer CRON_SECRET)
    → handleBehavioralPushSweep (api/_push/behavioralPushSweep.ts)
        SP 20:00 window gate → behavioral_push_candidates (1 SQL/batch, no N+1)
        per candidate: decide (pure) → entitlement → language+copy
                     → ATOMIC claim (UNIQUE(user_id, local_date))
                     → revalidate (fresh practiced-today + cooldown)
                     → real send OR dry_run → mark
    → OneSignal REST  (api/_push/oneSignalServer.ts): POST /notifications,
        include_aliases.external_id = Supabase UUID, target_channel=push. NEVER a broadcast.
```

No new Vercel function: the sweep is a `case` in the existing consolidated
dispatcher `api/internal/listening/[...slug].ts` (12/12 Hobby cap). The open
endpoint folds onto `grammar-explanation.ts` via `?__lemonRoute=behavioral-push-open`.

### Homolog / prod isolation

There is a **single** OneSignal app across environments. Isolation comes from:
1. **never broadcasting** — always `include_aliases.external_id`;
2. targeting **only** External IDs pulled from *this environment's own* Supabase
   DB; prod and homolog are separate Supabase projects → **disjoint UUIDs**;
3. `ONESIGNAL_APP_ID` + `ONESIGNAL_REST_API_KEY` are **explicit, fail-closed**
   (no fallback to the public client App ID).

### Attribution (association, NOT causality)

Each server-authoritative completion point calls
`record_behavioral_push_activity_conversion(user, type, completedAt)`
(best-effort, idempotent, isolated — a tracking failure never fails the
activity). It stamps, on the most recent `sent` push whose 24h window is open:
- `activity_after_send_at` (first activity after send — first wins);
- `activity_after_open_at` (if the push was opened first).

Completion points: writing `api/review-text.ts`; pronunciation
`api/pronunciation-training/*` + `api/pronunciation/*`; listening
`api/listening/* story/complete`; conversation `api/conversation/* session-complete`;
review `submit_error_review_item` (SQL — no Node handler).

### Open tracking

The push carries only `{ behavioral_push_event_id, push_type }`. On tap, the
client (`useBehavioralPushOpenSync`) routes Home and POSTs
`/api/behavioral-push/open`. The server authenticates the session (`requireAuth`)
and passes the **verified** userId to `behavioral_push_record_open` — never a
body userId. Cold start: the event id is persisted locally and flushed once the
session restores. `opened_at` is a server timestamp; first open wins.

## Configuration

Env (server-only — see `.env.example`): `ONESIGNAL_APP_ID`,
`ONESIGNAL_REST_API_KEY`, `BEHAVIORAL_PUSH_ENABLED`, `BEHAVIORAL_PUSH_DRY_RUN`,
`BEHAVIORAL_PUSH_TEST_USER_IDS`, `BEHAVIORAL_PUSH_ENVIRONMENT`.

Domain constants: `api/_push/behavioralPushDomain.ts::BEHAVIORAL_PUSH`
(cooldown 72h, missed-days 2, attribution 24h, eval hour 20 SP, batch size).

## Activation (manual, per environment, once)

1. Set the env vars above on the target Vercel project (homolog first).
2. Ensure Vault secrets `cron_secret` (== `CRON_SECRET`) and `app_base_url`
   exist for that environment.
3. Schedule the sweep in the SQL Editor (see the commented `cron.schedule`
   block in `20260829120100_behavioral_push_sweep_cron.sql`).

## Homolog test flow

1. `BEHAVIORAL_PUSH_ENABLED=true`, `BEHAVIORAL_PUSH_DRY_RUN=true` → sweep records
   dry_run rows only; inspect candidates in `behavioral_push_events`.
2. Set `BEHAVIORAL_PUSH_TEST_USER_IDS=<test uuid>`, `BEHAVIORAL_PUSH_DRY_RUN=`
   (empty) → only the test user gets a real send; everyone else stays dry_run.
3. Trigger once via `GET /api/internal/listening/behavioral-push-sweep?force=1`
   with the CRON_SECRET bearer (bypasses the 20:00 window).
4. Receive → tap → confirm `opened_at`; complete an activity → confirm
   `activity_after_send_at` / `activity_after_open_at`; confirm cooldown blocks a
   second send; confirm a second sweep run doesn't duplicate.

## Status semantics

`claimed` → `sent` | `failed` | `skipped` | `dry_run`. `sent` = OneSignal
accepted the send (NOT physical delivery — never call it `delivered`). Only
`sent` starts the cooldown; `dry_run`/`failed`/`skipped` do not.

## Test allowlist bypasses ACCOUNT-TYPE exclusions (homolog only)

`behavioral_push_candidates` takes `p_bypass_user_ids uuid[]`. For those UUIDs the
account-type exclusions (admin/internal, deactivated, comm-suppressed) are
ignored, so an allowlisted account (e.g. the owner) can be tested end-to-end.
The sweep only fills this with `BEHAVIORAL_PUSH_TEST_USER_IDS` when
`environment !== 'production'`; in production it passes `{}` (admins stay
excluded from retention). Doubly gated: non-production **and** on the allowlist.
Behavioral rules (practiced-today, cooldown, idempotency, weekday,
streak/abandonment) are **never** bypassed. Migration `20260831120000`.
