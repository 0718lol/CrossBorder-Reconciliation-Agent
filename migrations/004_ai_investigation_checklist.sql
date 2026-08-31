CREATE TABLE exception_ai_adoptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  exception_id uuid NOT NULL,
  ai_audit_id bigint NOT NULL,
  decision text NOT NULL CHECK (decision IN ('accepted', 'partially_accepted', 'rejected')),
  selected_steps jsonb NOT NULL DEFAULT '[]'::jsonb,
  reason text,
  decided_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (exception_id, ai_audit_id),
  FOREIGN KEY (tenant_id, exception_id) REFERENCES recon_exceptions (tenant_id, id),
  FOREIGN KEY (tenant_id, decided_by) REFERENCES tenant_members (tenant_id, user_id),
  CHECK (
    (decision = 'rejected' AND length(trim(COALESCE(reason, ''))) BETWEEN 2 AND 2000)
    OR (decision <> 'rejected' AND reason IS NULL)
  )
);

CREATE TABLE exception_investigation_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  exception_id uuid NOT NULL,
  ai_audit_id bigint,
  source text NOT NULL CHECK (source IN ('ai', 'manual')),
  title text NOT NULL CHECK (length(trim(title)) BETWEEN 2 AND 500),
  required boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'done', 'not_applicable')),
  result text,
  created_by uuid NOT NULL,
  updated_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, exception_id) REFERENCES recon_exceptions (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES tenant_members (tenant_id, user_id),
  FOREIGN KEY (tenant_id, updated_by) REFERENCES tenant_members (tenant_id, user_id),
  CHECK (status = 'todo' OR length(trim(COALESCE(result, ''))) BETWEEN 2 AND 2000)
);

CREATE INDEX exception_ai_adoptions_exception_created_idx
  ON exception_ai_adoptions (exception_id, created_at DESC, id);
CREATE INDEX exception_investigation_items_exception_status_idx
  ON exception_investigation_items (exception_id, status, created_at, id);

CREATE OR REPLACE FUNCTION touch_investigation_item_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER exception_investigation_items_touch_updated_at
BEFORE UPDATE ON exception_investigation_items
FOR EACH ROW EXECUTE FUNCTION touch_investigation_item_updated_at();
