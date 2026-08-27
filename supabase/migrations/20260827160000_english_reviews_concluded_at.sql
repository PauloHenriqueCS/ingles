-- Writing activity: explicit "concluded" milestone for the redesigned flow.
--
-- The new guided flow (Missão → Escrever → Feedback → Concluir) makes writing a
-- second version (V2) OPTIONAL: after the V1 feedback the learner can always
-- conclude the activity. Completion for the calendar/streak/curriculum already
-- happens at 'corrigido' (see src/domain/writing/entry-status.ts) — this column
-- does NOT change any of that accounting. It records ONLY the UI milestone "the
-- learner tapped Concluir", so that on refresh / return-from-Home a V1-only
-- writing restores to the "✓ Escrita concluída" screen instead of the Feedback
-- screen. A writing that already has a final V2 version (version_2_final_text)
-- is terminal regardless of this column.
--
-- Additive and non-commercial: it never gates a feature, never consumes quota,
-- and is written best-effort by the owner (same owner-update path as
-- version_2_text / version_2_final_text). Idempotent: setting it again is a
-- no-op transition. The client reads english_reviews with select('*'), so the
-- column is picked up transparently with no read-path change; code degrades
-- gracefully when the column is absent (concluded_at simply reads as undefined).

ALTER TABLE public.english_reviews
  ADD COLUMN IF NOT EXISTS concluded_at timestamptz;

COMMENT ON COLUMN public.english_reviews.concluded_at IS
  'When the learner explicitly concluded the writing activity from the Feedback step (V1-only path). Presentation milestone only; calendar/curriculum credit is unaffected. NULL until concluded; a final V2 version also counts as concluded regardless of this value.';
