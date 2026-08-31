ALTER TABLE recon_exceptions
  DROP CONSTRAINT recon_exceptions_status_check;

ALTER TABLE recon_exceptions
  ADD COLUMN assignee_id uuid,
  ADD COLUMN assigned_at timestamptz,
  ADD COLUMN workflow_version integer NOT NULL DEFAULT 0 CHECK (workflow_version >= 0),
  ADD COLUMN resolved_by uuid,
  ADD COLUMN resolved_at timestamptz,
  ADD CONSTRAINT recon_exceptions_status_check
    CHECK (status IN ('open', 'investigating', 'pending_review', 'resolved')),
  ADD CONSTRAINT recon_exceptions_tenant_id_id_unique UNIQUE (tenant_id, id),
  ADD CONSTRAINT recon_exceptions_assignee_member_fk
    FOREIGN KEY (tenant_id, assignee_id) REFERENCES tenant_members (tenant_id, user_id),
  ADD CONSTRAINT recon_exceptions_resolver_member_fk
    FOREIGN KEY (tenant_id, resolved_by) REFERENCES tenant_members (tenant_id, user_id),
  ADD CONSTRAINT recon_exceptions_resolution_fields_check
    CHECK (
      (status = 'resolved' AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL)
      OR (status <> 'resolved' AND resolved_by IS NULL AND resolved_at IS NULL)
    );

CREATE TABLE exception_notes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL,
  exception_id uuid NOT NULL,
  author_id uuid NOT NULL,
  body text NOT NULL CHECK (length(trim(body)) BETWEEN 2 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, exception_id) REFERENCES recon_exceptions (tenant_id, id),
  FOREIGN KEY (tenant_id, author_id) REFERENCES tenant_members (tenant_id, user_id)
);

ALTER TABLE recon_runs
  ADD CONSTRAINT recon_runs_tenant_id_id_unique UNIQUE (tenant_id, id);

CREATE TABLE exception_resolution_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  exception_id uuid NOT NULL,
  proposal_version integer NOT NULL CHECK (proposal_version > 0),
  resolution_type text NOT NULL CHECK (resolution_type IN (
    'timing_difference', 'fee_difference', 'duplicate_record',
    'manual_link', 'source_correction', 'other'
  )),
  summary text NOT NULL CHECK (length(trim(summary)) BETWEEN 10 AND 2000),
  financial_impact boolean NOT NULL,
  replacement_run_id uuid,
  submitted_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (exception_id, proposal_version),
  FOREIGN KEY (tenant_id, exception_id) REFERENCES recon_exceptions (tenant_id, id),
  FOREIGN KEY (tenant_id, submitted_by) REFERENCES tenant_members (tenant_id, user_id),
  CONSTRAINT exception_resolution_proposals_replacement_run_fk
    FOREIGN KEY (tenant_id, replacement_run_id) REFERENCES recon_runs (tenant_id, id),
  CHECK (
    (financial_impact AND replacement_run_id IS NOT NULL)
    OR (NOT financial_impact AND replacement_run_id IS NULL)
  )
);

CREATE TABLE exception_resolution_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  proposal_id uuid NOT NULL UNIQUE,
  decision text NOT NULL CHECK (decision IN ('approved', 'rejected')),
  reason text,
  decided_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, proposal_id) REFERENCES exception_resolution_proposals (tenant_id, id),
  FOREIGN KEY (tenant_id, decided_by) REFERENCES tenant_members (tenant_id, user_id),
  CHECK (
    (decision = 'rejected' AND length(trim(reason)) BETWEEN 10 AND 2000)
    OR (decision = 'approved' AND (reason IS NULL OR length(trim(reason)) BETWEEN 2 AND 2000))
  )
);

CREATE INDEX exception_notes_exception_created_idx
  ON exception_notes (exception_id, created_at, id);
CREATE INDEX exception_proposals_exception_version_idx
  ON exception_resolution_proposals (exception_id, proposal_version DESC);
CREATE INDEX recon_exceptions_tenant_workflow_idx
  ON recon_exceptions (tenant_id, status, assignee_id, created_at DESC);

CREATE TRIGGER exception_notes_no_update_delete
BEFORE UPDATE OR DELETE ON exception_notes
FOR EACH ROW EXECUTE FUNCTION reject_immutable_recon_fact();

CREATE TRIGGER exception_resolution_proposals_no_update_delete
BEFORE UPDATE OR DELETE ON exception_resolution_proposals
FOR EACH ROW EXECUTE FUNCTION reject_immutable_recon_fact();

CREATE TRIGGER exception_resolution_decisions_no_update_delete
BEFORE UPDATE OR DELETE ON exception_resolution_decisions
FOR EACH ROW EXECUTE FUNCTION reject_immutable_recon_fact();
