# HyperRecon Exception Workflow v0.6

## Confirmed business contract

- Several operators may share one queue. Any operator may claim an unassigned exception, but only one operator is the current owner.
- Other operators may inspect owned work but cannot submit a competing result.
- All blocking exceptions require four-eyes review. The submitter cannot approve their own proposal.
- Rejection requires a reason and returns the exception to its current operator.
- Notes, proposals, decisions, original records, and reconciliation facts remain available as history; corrections never overwrite original financial facts.
- A resolution that changes an amount or match relationship must reference a different completed reconciliation run for the same period with no unresolved blocking exception.
- An approved financial resolution supersedes the original run for close. The old run is rejected from the close snapshot and the replacement run must be selected.
- Period close remains blocked until every selected run has no unresolved blocking exception.

## Workflow

```text
open
  -> operator claim or admin assignment
investigating
  -> append notes
  -> request an AI investigation suggestion (optional)
  -> record accept / partial accept / reject decision
  -> complete required investigation checklist items
  -> operator submits versioned proposal
pending_review
  -> reviewer/admin rejects with reason -> investigating
  -> reviewer/admin approves -> resolved
```

Every mutation requires the current `workflow_version`. A stale request fails instead of overwriting a concurrent action.

## Role boundary

| Action | Admin | Operator | Reviewer | Auditor |
|---|---:|---:|---:|---:|
| View exception and history | Yes | Yes | Yes | Yes |
| Assign to an operator | Yes | No | No | No |
| Claim/release own work | No | Yes | No | No |
| Add investigation note | Yes | Owner only | During review | No |
| Request an AI suggestion | No | Yes | Yes | No |
| Adopt an AI suggestion into checklist | No | Owner only | No | No |
| Add/update investigation checklist | No | Owner only | No | No |
| Submit resolution | No | Owner only | No | No |
| Approve/reject | Yes | No | Yes | No |
| Upload/start reconciliation | Yes | Yes | No | No |

## Explicit boundary

The workflow records reviewed human conclusions. It does not let AI change amounts, create matches, approve a proposal, or unblock close. Formal evidence-package download, rule authoring, RLS, and production authentication remain outside this iteration.

## AI investigation suggestions

- Operators and reviewers may manually request a DeepSeek investigation suggestion for an unresolved exception.
- The external request contains only category metadata: exception type, severity, status, source type, record type, engine-side role, candidate count, and workflow version.
- Amounts, currencies, dates, external record identifiers, tenant identity, user identity, notes, and resolution proposals are not sent to the model.
- A successful structured response is stored in the append-only audit log as `ai.exception_suggestion_generated` and shown separately from human notes and proposals.
- Provider failures and invalid responses create no audit event and do not change the exception workflow version or status.
- The current owner may record an AI suggestion as accepted, partially accepted, or rejected. Accepting automatically adds every suggested step as a required investigation item; partial acceptance must select a proper subset. Rejection requires a written reason. The adoption decision remains in the audit history.
- The owner may add manual required or optional checklist items. Completing or marking a required item as not applicable requires a written result.
- A resolution proposal cannot be submitted while a required checklist item remains unfinished. Exceptions that have no checklist retain the existing workflow for backward compatibility.
- AI suggestions and checklist results cannot populate or submit a human proposal, approve or reject a resolution, alter financial facts, or directly remove a close blocker. Only an approved human resolution changes an exception to `resolved`.
