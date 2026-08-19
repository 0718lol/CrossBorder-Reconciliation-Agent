CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE member_role AS ENUM ('operator', 'reviewer', 'admin', 'auditor');
CREATE TYPE batch_status AS ENUM ('uploaded', 'preflight_failed', 'ready', 'committed', 'failed');

CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(trim(name)) > 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deleted')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  password_hash text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX users_email_lower_unique_idx ON users (lower(email));

CREATE TABLE tenant_members (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  user_id uuid NOT NULL REFERENCES users(id),
  role member_role NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid REFERENCES tenants(id),
  actor_id uuid REFERENCES users(id),
  action text NOT NULL,
  object_type text NOT NULL,
  object_id text NOT NULL,
  request_id text,
  reason text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION reject_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events are append-only';
END;
$$;

CREATE TRIGGER audit_events_no_update_delete
BEFORE UPDATE OR DELETE ON audit_events
FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();

CREATE TABLE data_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL,
  source_type text NOT NULL CHECK (source_type IN ('stripe', 'paypal', 'wise', 'bank', 'shopify')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE TABLE import_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  data_source_id uuid NOT NULL REFERENCES data_sources(id),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  original_filename text NOT NULL,
  byte_size bigint NOT NULL CHECK (byte_size >= 0),
  parser_version text NOT NULL,
  template_version text NOT NULL,
  status batch_status NOT NULL,
  encoding text NOT NULL,
  delimiter text NOT NULL,
  row_count integer NOT NULL DEFAULT 0 CHECK (row_count >= 0),
  error_count integer NOT NULL DEFAULT 0 CHECK (error_count >= 0),
  error_report jsonb NOT NULL DEFAULT '[]'::jsonb,
  object_path text NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  committed_at timestamptz,
  UNIQUE (tenant_id, data_source_id, sha256, parser_version, template_version)
);

CREATE TABLE raw_rows (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  import_batch_id uuid NOT NULL REFERENCES import_batches(id),
  row_number integer NOT NULL CHECK (row_number >= 2),
  row_hash text NOT NULL CHECK (row_hash ~ '^[0-9a-f]{64}$'),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (import_batch_id, row_number)
);

CREATE TABLE canonical_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  import_batch_id uuid NOT NULL REFERENCES import_batches(id),
  raw_row_id bigint NOT NULL REFERENCES raw_rows(id),
  source_type text NOT NULL,
  external_id text NOT NULL,
  record_type text NOT NULL,
  event_at timestamptz,
  value_date date,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  gross_minor bigint,
  fee_minor bigint,
  net_minor bigint NOT NULL,
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, source_type, external_id, import_batch_id)
);

CREATE INDEX import_batches_tenant_created_idx ON import_batches (tenant_id, created_at DESC);
CREATE INDEX canonical_records_tenant_currency_idx ON canonical_records (tenant_id, currency, value_date);
CREATE INDEX audit_events_tenant_created_idx ON audit_events (tenant_id, created_at DESC);
