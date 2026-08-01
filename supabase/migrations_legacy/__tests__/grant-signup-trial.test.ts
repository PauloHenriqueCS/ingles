/**
 * Static SQL-text assertions for 20260727230500_grant_signup_trial.sql — no
 * live database connection here (same posture as the other migration static
 * tests in this directory).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const sql = readFileSync(
  resolve(__dirname, '..', '20260727230500_grant_signup_trial.sql'),
  'utf8',
);

const fnBody = sql.slice(
  sql.indexOf('CREATE OR REPLACE FUNCTION public.grant_signup_trial_v1'),
  sql.lastIndexOf('$$;'),
);

describe('20260727230500 — grant_signup_trial_v1', () => {
  it('is SECURITY DEFINER with a pinned search_path', () => {
    expect(sql).toMatch(/SECURITY DEFINER/);
    expect(sql).toMatch(/SET search_path TO 'public'/);
  });

  it('fires AFTER INSERT ON auth.users', () => {
    expect(sql).toMatch(/CREATE TRIGGER trg_grant_signup_trial\s*\n\s*AFTER INSERT ON auth\.users/);
  });

  it('is idempotent: drops the trigger before recreating it', () => {
    expect(sql).toContain('DROP TRIGGER IF EXISTS trg_grant_signup_trial ON auth.users;');
  });

  it('CRITICAL: never lets an exception escape and abort the signup transaction — wraps the whole body in EXCEPTION WHEN OTHERS THEN RETURN NEW', () => {
    const exceptionIdx = fnBody.indexOf('EXCEPTION WHEN OTHERS THEN');
    expect(exceptionIdx).toBeGreaterThan(-1);
    // The handler must be the LAST thing before the function body ends —
    // i.e. it wraps everything above it, not just a sub-block.
    const afterException = fnBody.slice(exceptionIdx);
    expect(afterException).toMatch(/EXCEPTION WHEN OTHERS THEN\s*\n(?:\s*--[^\n]*\n)*\s*RETURN NEW;/);
  });

  it('always returns NEW — never NULL — so the insert into auth.users is never suppressed', () => {
    expect(fnBody).not.toMatch(/RETURN NULL/);
  });

  it('reads duration/enablement from plan_trial_policies first, falling back to plans.trial_days only when no policy row exists', () => {
    const policyIdx = fnBody.indexOf('FROM public.plan_trial_policies');
    const fallbackIdx = fnBody.indexOf('IF NOT FOUND THEN');
    const trialDaysIdx = fnBody.indexOf('SELECT trial_days INTO v_duration_days FROM public.plans');
    expect(policyIdx).toBeGreaterThan(-1);
    expect(fallbackIdx).toBeGreaterThan(policyIdx);
    expect(trialDaysIdx).toBeGreaterThan(fallbackIdx);
  });

  it('never grants when duration is missing/non-positive or the policy disables trials', () => {
    expect(fnBody).toMatch(/IF NOT COALESCE\(v_trial_enabled, FALSE\) OR v_duration_days IS NULL OR v_duration_days <= 0 THEN\s*\n\s*RETURN NEW;/);
  });

  it('never grants a second time beyond max_grants_per_user — counts PAST trial-origin assignments for this user+plan first', () => {
    expect(fnBody).toMatch(/SELECT count\(\*\) INTO v_prior_grants\s*\n\s*FROM public\.user_plan_assignments\s*\n\s*WHERE user_id = NEW\.id AND plan_id = v_trial_plan_id AND origin = 'trial';/);
    expect(fnBody).toMatch(/IF v_prior_grants >= COALESCE\(v_max_grants, 1\) THEN\s*\n\s*RETURN NEW;/);
  });

  it('grants origin=trial, status=active, starting now, ending now + duration_days — never a hardcoded literal for ends_at', () => {
    expect(fnBody).toMatch(/'follow_current_published', 'trial',\s*\n\s*now\(\), now\(\) \+ \(v_duration_days::text \|\| ' days'\)::interval, 'active',/);
  });

  it('sets created_by to the new user themselves (NEW.id) — no admin actor exists in this context', () => {
    expect(fnBody).toContain('NEW.id, \'Concessão automática do teste gratuito no cadastro');
  });

  it('never touches an existing assignment — INSERT only, no UPDATE/DELETE', () => {
    expect(fnBody).not.toMatch(/\bUPDATE\b/);
    expect(fnBody).not.toMatch(/\bDELETE\b/);
  });
});
