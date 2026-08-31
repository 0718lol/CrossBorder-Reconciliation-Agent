ALTER TABLE exception_ai_adoptions
  ADD CONSTRAINT exception_ai_adoptions_audit_fk
  FOREIGN KEY (ai_audit_id) REFERENCES audit_events (id),
  ADD CONSTRAINT exception_ai_adoptions_steps_array_check
  CHECK (jsonb_typeof(selected_steps) = 'array');

ALTER TABLE exception_investigation_items
  ADD CONSTRAINT exception_investigation_items_audit_fk
  FOREIGN KEY (ai_audit_id) REFERENCES audit_events (id),
  ADD CONSTRAINT exception_investigation_items_source_audit_check
  CHECK (
    (source = 'ai' AND ai_audit_id IS NOT NULL)
    OR (source = 'manual' AND ai_audit_id IS NULL)
  );
