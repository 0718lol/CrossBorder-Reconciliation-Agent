# HyperRecon Role Workspaces v0.4

## Purpose

Turn the existing four backend roles into four visibly different finance jobs. A user must understand what they are responsible for within the first viewport. Navigation, landing content, controls, and data requests must reflect the same role model, while the server remains the final authorization boundary.

## Research synthesis

- Medusa issue #15945 documents the failure mode where routes are protected but the sidebar still advertises inaccessible pages. HyperRecon must filter navigation before presenting it.
- next-shadcn-dashboard-starter derives client navigation from roles and permissions. HyperRecon should likewise use one declarative role model instead of scattered role checks.
- Apache Superset separates fully trusted administrators from restricted readers and warns that a read-only surface still needs every read dependency required to render successfully. HyperRecon must not issue forbidden requests and then fail the whole workspace.
- RBACStack uses module/action capabilities and permission-aware quick actions. HyperRecon should make each landing page task-oriented rather than merely hiding controls.

References:

- https://github.com/medusajs/medusa/issues/15945
- https://github.com/Kiranism/next-shadcn-dashboard-starter
- https://github.com/apache/superset/blob/master/docs/admin_docs/security/security.mdx
- https://github.com/cybernazmul/RBACStack

## Detailed implementation prompt

You are modifying the HyperRecon Foundation console, a PostgreSQL-backed cross-border reconciliation application. Implement role-specific workspaces for `admin`, `operator`, `reviewer`, and `auditor` using the existing plain HTML, CSS, and JavaScript architecture.

### Non-negotiable constraints

1. The server remains the security boundary. Frontend filtering improves comprehension but must never be described as authorization enforcement.
2. Define role navigation, labels, capabilities, and optional data reads in one pure JavaScript role model that can be tested without a DOM.
3. Unknown roles fail closed: no mutation controls and only a minimal overview fallback.
4. Do not request APIs the current role cannot read. In particular, `operator` must not request `/periods`, and only `admin` and `auditor` may request `/audit-events`.
5. Do not invent assignment, approval, exception resolution, evidence export, user management, or rule-authoring features. Clearly label missing workflows.
6. Preserve exact minor-unit amount handling and tenant-scoped APIs.
7. Preserve the current admin money cockpit and its two honest evidence chains. Do not imply an order-to-payout relationship that the data cannot prove.
8. Reviewer import/run controls are hidden in this version to express maker-checker separation, but existing backend authorization remains unchanged until the product owner explicitly approves tightening it.
9. Every visible navigation item must lead to a usable page for that role. Every hidden page must also be guarded by client navigation fallback.
10. Responsive layouts must have no horizontal page overflow at 390px and 1280px viewports.

### Role and navigation matrix

| Role | Landing identity | Visible navigation |
|---|---|---|
| Admin | Global money control | Money cockpit, data intake, reconciliation runs, exceptions, period close, audit log |
| Operator | Daily money operations | My work, data intake, reconciliation tasks, investigation queue |
| Reviewer | Review and close control | Review center, reconciliation results, exception review, period close |
| Auditor | Independent evidence review | Audit overview, reconciliation evidence, close archive, audit log |

### Landing-page contracts

#### Admin

- Keep the current multi-currency cockpit.
- Show operational exceptions and control health.
- Retain the matched-evidence and blocked-evidence scenarios.

#### Operator

- Headline: finish today's money operations.
- Prioritize open exceptions, recent import batches, and recent reconciliation runs.
- Expose shortcuts only to data intake, new runs, and exception investigation.
- Explicitly state that period locking and audit administration belong to other roles.

#### Reviewer

- Headline: decide whether the period can close safely.
- Prioritize blocking exceptions, close readiness, completed run evidence, and period state.
- Expose shortcuts to reconciliation results, exception review, and period close.
- Do not show import or run creation controls in the UI.

#### Auditor

- Headline: trace evidence without changing operational state.
- Prioritize canonical record counts, verified match groups, locked periods, and audit-event volume.
- Show recent evidence chains and recent audit activity.
- Present all surfaces as read-only and expose no mutation buttons.

### Capability matrix for this iteration

| Capability | Admin | Operator | Reviewer | Auditor |
|---|---:|---:|---:|---:|
| Read core financial data | Yes | Yes | Yes | Yes |
| Upload CSV | Yes | Yes | UI hidden | No |
| Start reconciliation | Yes | Yes | UI hidden | No |
| Read periods | Yes | No | Yes | Yes |
| Create/close period | Yes | No | Yes | No |
| Read audit log | Yes | No | No | Yes |

### Verification

- Pure unit tests assert exact navigation, mutation capabilities, and optional data reads for all roles.
- Full database test suite passes.
- Browser test each seeded demo identity:
  - visible navigation matches the matrix;
  - landing title and primary content are role-specific;
  - forbidden controls are absent;
  - no request failure leaves the workspace blank;
  - no console error or horizontal overflow occurs.

## Known boundary after v0.4

This iteration differentiates real roles using existing data. Exception assignment/resolution, four-eyes approval, evidence-package export, and member/role administration remain unimplemented. Backend permissions still allow reviewers to import and start runs for compatibility even though the reviewer UI hides those controls. Tightening that backend contract requires an explicit product decision and dedicated authorization tests.
