CREATE TABLE recon_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  period_start date NOT NULL,
  period_end date NOT NULL,
  status text NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  rule_definition jsonb NOT NULL,
  rule_sha256 text NOT NULL CHECK (rule_sha256 ~ '^[0-9a-f]{64}$'),
  engine_version text NOT NULL,
  record_highwater timestamptz NOT NULL,
  idempotency_key text NOT NULL,
  stats jsonb NOT NULL DEFAULT '{}'::jsonb,
  error jsonb,
  created_by uuid NOT NULL REFERENCES users(id),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CHECK (period_start <= period_end),
  UNIQUE (tenant_id, idempotency_key)
);

CREATE TABLE match_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  recon_run_id uuid NOT NULL REFERENCES recon_runs(id),
  match_type text NOT NULL CHECK (match_type IN ('one_to_one', 'many_to_one', 'one_to_many', 'partial')),
  status text NOT NULL DEFAULT 'matched' CHECK (status = 'matched'),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  source_total_minor bigint NOT NULL CHECK (source_total_minor > 0),
  target_total_minor bigint NOT NULL CHECK (target_total_minor > 0),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (amount_minor = source_total_minor AND source_total_minor = target_total_minor)
);

CREATE TABLE record_allocations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  recon_run_id uuid NOT NULL REFERENCES recon_runs(id),
  match_group_id uuid NOT NULL REFERENCES match_groups(id),
  canonical_record_id uuid NOT NULL REFERENCES canonical_records(id),
  role text NOT NULL CHECK (role IN ('source', 'target', 'adjustment')),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  allocated_minor bigint NOT NULL CHECK (allocated_minor > 0),
  rule_step text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (match_group_id, canonical_record_id, role)
);

CREATE TABLE recon_exceptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  recon_run_id uuid NOT NULL REFERENCES recon_runs(id),
  canonical_record_id uuid REFERENCES canonical_records(id),
  exception_type text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('warning', 'blocking')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  amount_minor bigint,
  currency text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (recon_run_id, dedupe_key)
);

CREATE TABLE close_periods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  period_start date NOT NULL,
  period_end date NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  status text NOT NULL CHECK (status IN ('open', 'locked')),
  parent_period_id uuid REFERENCES close_periods(id),
  snapshot jsonb,
  manifest_sha256 text CHECK (manifest_sha256 IS NULL OR manifest_sha256 ~ '^[0-9a-f]{64}$'),
  reopen_reason text,
  created_by uuid NOT NULL REFERENCES users(id),
  closed_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  CHECK (period_start <= period_end),
  UNIQUE (tenant_id, period_start, period_end, version)
);

CREATE UNIQUE INDEX close_periods_one_open_idx
  ON close_periods (tenant_id, period_start, period_end)
  WHERE status = 'open';

CREATE TABLE close_period_runs (
  close_period_id uuid NOT NULL REFERENCES close_periods(id),
  recon_run_id uuid NOT NULL REFERENCES recon_runs(id),
  PRIMARY KEY (close_period_id, recon_run_id)
);

CREATE INDEX recon_runs_tenant_period_idx ON recon_runs (tenant_id, period_start, period_end, started_at DESC);
CREATE INDEX allocations_run_record_idx ON record_allocations (recon_run_id, canonical_record_id);
CREATE INDEX recon_exceptions_run_status_idx ON recon_exceptions (recon_run_id, status, severity);
CREATE INDEX close_periods_tenant_period_idx ON close_periods (tenant_id, period_start, period_end, version DESC);

CREATE OR REPLACE FUNCTION reject_immutable_recon_fact() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'reconciliation facts are immutable';
END;
$$;

CREATE TRIGGER match_groups_no_update_delete
BEFORE UPDATE OR DELETE ON match_groups
FOR EACH ROW EXECUTE FUNCTION reject_immutable_recon_fact();

CREATE TRIGGER record_allocations_no_update_delete
BEFORE UPDATE OR DELETE ON record_allocations
FOR EACH ROW EXECUTE FUNCTION reject_immutable_recon_fact();

CREATE OR REPLACE FUNCTION protect_completed_recon_run() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.status IN ('completed', 'failed') THEN
    RAISE EXCEPTION 'completed reconciliation runs are immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER recon_runs_completed_no_update_delete
BEFORE UPDATE OR DELETE ON recon_runs
FOR EACH ROW EXECUTE FUNCTION protect_completed_recon_run();

CREATE OR REPLACE FUNCTION protect_locked_period() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.status = 'locked' THEN
    RAISE EXCEPTION 'locked periods are immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER close_periods_locked_no_update_delete
BEFORE UPDATE OR DELETE ON close_periods
FOR EACH ROW EXECUTE FUNCTION protect_locked_period();
