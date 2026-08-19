# HyperRecon Foundation Service v0.2

This service is the local Foundation baseline for the reconciliation product. It provides PostgreSQL-backed tenant isolation, password sessions, append-only audit events, source-specific CSV preflight, content-addressed file storage, transactional imports, deterministic bounded matching, immutable allocation facts, and versioned period close/reopen.

All files under `fixtures/` are fictional golden samples derived from public field contracts. They contain no merchant or personal data.

## Run locally

Requirements: Docker Desktop and the bundled Node.js/pnpm runtime used by Codex, or Node.js 22+ with pnpm.

```sh
docker compose up -d postgres
pnpm run migrate
BOOTSTRAP_TOKEN=replace-with-a-long-random-value pnpm start
```

The API binds to `127.0.0.1:4180`. PostgreSQL binds to `127.0.0.1:55432` for local development only.
The Compose file uses DaoCloud's transparent mirror path for the Docker Official Image because Docker Hub was unreliable on the current network; the mirrored manifest preserves the upstream digest.

## Open the operations console

After starting the API, open `http://127.0.0.1:4180/console/`. The console is backed by the same API and database; it is not a static mock.

To load the fictional multi-currency demo workspace:

```sh
pnpm run demo:seed
```

The seed command prints the demo login credentials. The demo fixtures contain only fictional USD, EUR, and GBP records.

## Verify

```sh
pnpm test
RUN_DATABASE_TESTS=1 pnpm run test:integration
pnpm run test:all
```

The integration suite verifies commit, content-addressed file publication, replay idempotency, injected mid-import rollback, append-only audit enforcement, cross-tenant denial, 1:1/combination/partial matching, ambiguity handling, allocation conservation, close blocking, period locking, import rejection after lock, and versioned reopen.

## API surface

- `POST /v1/bootstrap` creates a local tenant, admin, and default sources with `X-Bootstrap-Token`.
- `POST /v1/sessions` and `DELETE /v1/sessions/current` manage bearer sessions.
- `POST /v1/tenants/:tenantId/sources/:sourceId/import-batches` validates and commits one CSV.
- `GET /v1/tenants/:tenantId/import-batches` lists committed batches.
- `POST /v1/tenants/:tenantId/recon-runs` executes a fixed-period rule with an `Idempotency-Key` header.
- `GET /v1/tenants/:tenantId/recon-runs` and `GET /v1/tenants/:tenantId/recon-runs/:runId` expose run evidence.
- `POST /v1/tenants/:tenantId/periods` creates or returns an open period.
- `POST /v1/tenants/:tenantId/periods/:periodId/close` locks a clean set of completed runs.
- `POST /v1/tenants/:tenantId/periods/:periodId/reopen` creates a new period version and requires a reason.
- `GET /v1/tenants/:tenantId/periods` and `/audit-events` expose close and audit history.

The matcher supports 1:1, unique many-to-one, unique one-to-many, and conservative partial allocation. Explicit identifiers never degrade to amount-only matching. Ambiguous or over-budget candidates become blocking exceptions.

## Current boundary

This is a Foundation service, not the completed reconciliation product. It has a JSON rule contract and close manifest, but not a rule-authoring UI, exception resolution/approval workflow, `.xlsx`/PDF evidence package, S3 storage, or upstream Recon Engine API adapter. Tenant isolation is currently enforced by authorization joins and tenant-filtered queries; PostgreSQL row-level security is a production hardening item.
