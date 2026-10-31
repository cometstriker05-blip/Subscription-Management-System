-- Concurrent writers took their id before the chain lock, so id order could differ from
-- hash order and a healthy log looked tampered with. The id now comes after the lock,
-- which makes id order and chain order the same thing.
CREATE OR REPLACE FUNCTION audit_chain() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE head text;
BEGIN
  SELECT hash INTO head FROM audit_head WHERE id = 1 FOR UPDATE;
  NEW.id := nextval('audit_log_id_seq');
  NEW.prev_hash := head;
  NEW.at := date_trunc('milliseconds', NEW.at);
  NEW.hash := encode(sha256(convert_to(
    head || '|' || NEW.actor || '|' || NEW.action || '|' || NEW.entity || '|' || coalesce(NEW.entity_id, '') || '|' || NEW.detail::text,
    'UTF8')), 'hex');
  UPDATE audit_head SET hash = NEW.hash WHERE id = 1;
  RETURN NEW;
END $$;
