-- Trigger: once accepted_at is set, content fields become immutable.
-- Blocks any UPDATE that tries to change title, prompt, level, difficulty, etc.

CREATE OR REPLACE FUNCTION protect_mission_content_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- Content is frozen as soon as accepted_at is set.
  IF OLD.accepted_at IS NOT NULL THEN
    IF NEW.title            IS DISTINCT FROM OLD.title            OR
       NEW.prompt_pt_br     IS DISTINCT FROM OLD.prompt_pt_br     OR
       NEW.level            IS DISTINCT FROM OLD.level            OR
       NEW.difficulty       IS DISTINCT FROM OLD.difficulty       OR
       NEW.suggested_words  IS DISTINCT FROM OLD.suggested_words  OR
       NEW.support_sentences IS DISTINCT FROM OLD.support_sentences OR
       NEW.mode             IS DISTINCT FROM OLD.mode             OR
       NEW.pedagogical_plan_id IS DISTINCT FROM OLD.pedagogical_plan_id OR
       NEW.legacy_theme_id  IS DISTINCT FROM OLD.legacy_theme_id
    THEN
      RAISE EXCEPTION
        'Mission content is immutable after acceptance (mission_id: %)', OLD.id
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_protect_mission_content_immutability
  BEFORE UPDATE ON writing_missions
  FOR EACH ROW
  EXECUTE FUNCTION protect_mission_content_immutability();
