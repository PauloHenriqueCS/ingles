-- ============================================================================
-- Security hardening — shared/global cache tables must not be client-writable,
-- and legacy `user_id IS NULL` fallback policies must not expose data anonymously.
--
-- Principle enforced: an authenticated client is NOT a trusted client. A row
-- that is served to EVERY user (a global cache) may never be INSERT/UPDATE-able
-- directly by an end user, and no policy may widen access via a
-- `user_id IS NULL` OR-branch.
--
-- Idempotent and additive: safe to re-run and safe on an existing database
-- (every DROP uses IF EXISTS; writes already go through the service-role client,
-- which bypasses RLS, so removing the client-facing write policies changes no
-- legitimate behavior).
-- ============================================================================

-- ── grammar_explanations: global cache keyed by `name`, served to all users ──
-- Was: ge_insert WITH CHECK (true) + ge_update USING/ WITH CHECK (true) for
-- role `authenticated` → any logged-in user could poison the explanation every
-- other user then receives (see api/grammar-explanation.ts:303, whose comment
-- already asserts "service role only; users cannot write directly" — this makes
-- that invariant true). The server READS this cache with the user's client, so
-- the SELECT policy stays; only the client-facing write policies are removed.
-- The cache is (re)populated exclusively by the service-role client in
-- api/grammar-explanation.ts, which bypasses RLS and is unaffected.
DROP POLICY IF EXISTS ge_insert ON public.grammar_explanations;
DROP POLICY IF EXISTS ge_update ON public.grammar_explanations;

-- ── english_learning_memory: drop the legacy permissive policies ─────────────
-- The table already has the correct owner-scoped set (elm_select/insert/update/
-- delete → auth.uid() = user_id, role `authenticated`). The legacy set below,
-- granted to role `public` with `(auth.uid() = user_id) OR (user_id IS NULL)`,
-- is OR-combined with the strict set and therefore WIDENS access: any client
-- (incl. anon) could read/update any `user_id IS NULL` row and insert NULL-owner
-- rows. The app only ever reads/writes the caller's own rows (src/lib/
-- learningMemory.ts, useTutorPreferences.ts — always the authenticated user),
-- so removing the NULL-fallback policies changes no legitimate behavior.
DROP POLICY IF EXISTS "Allow select english learning memory" ON public.english_learning_memory;
DROP POLICY IF EXISTS "Allow insert english learning memory" ON public.english_learning_memory;
DROP POLICY IF EXISTS "Allow update english learning memory" ON public.english_learning_memory;
