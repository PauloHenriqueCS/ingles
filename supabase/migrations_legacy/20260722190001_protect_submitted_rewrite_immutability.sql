-- Trigger: once submitted_at is set, content fields become immutable.

CREATE OR REPLACE FUNCTION protect_rewrite_submission_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.submitted_at IS NOT NULL THEN
    IF NEW.rewrite_text              IS DISTINCT FROM OLD.rewrite_text             OR
       NEW.original_text_snapshot   IS DISTINCT FROM OLD.original_text_snapshot   OR
       NEW.review_id                IS DISTINCT FROM OLD.review_id                OR
       NEW.mission_id               IS DISTINCT FROM OLD.mission_id               OR
       NEW.user_id                  IS DISTINCT FROM OLD.user_id                  OR
       NEW.rewrite_sequence         IS DISTINCT FROM OLD.rewrite_sequence         OR
       NEW.submitted_at             IS DISTINCT FROM OLD.submitted_at             OR
       NEW.support_usage_snapshot   IS DISTINCT FROM OLD.support_usage_snapshot
    THEN
      RAISE EXCEPTION
        'Rewrite content is immutable after submission (attempt_id: %)', OLD.id
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_protect_rewrite_submission_immutability
  BEFORE UPDATE ON writing_rewrite_attempts
  FOR EACH ROW
  EXECUTE FUNCTION protect_rewrite_submission_immutability();
