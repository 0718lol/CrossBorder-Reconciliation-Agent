# HyperRecon Close Archive Demo v0.5

## Research basis

- ERPNext represents period close as a submitted Period Closing Voucher and carries that closing reference into later financial-statement calculations.
- Odoo distinguishes soft and hard lock dates, tracks lock changes, and blocks period close while unreconciled bank items remain.
- HyperRecon already has a stronger domain-specific primitive for cross-border reconciliation: an immutable close snapshot with run hashes, file hashes, exact allocation totals, and an audit high-water mark.

References:

- https://github.com/frappe/erpnext/blob/develop/erpnext/accounts/report/financial_statements.py
- https://github.com/odoo/odoo/blob/19.0/addons/account/models/company.py

## Executable implementation prompt

Implement an inspectable month-close archive without fabricating downloadable evidence.

1. Seed one real locked demo version using an existing completed reconciliation run with zero blocking exceptions. Generate the manifest only through `closePeriod`; never insert a hash or snapshot directly.
2. Reopen the locked version once so the demo contains both a historical locked archive and a current open version. The seed must be replay-safe and must not create another version when both already exist.
3. Add a tenant-scoped read endpoint for a single period archive. Allow only `admin`, `reviewer`, and `auditor`. Return 404 when the period does not belong to the tenant.
4. Make every period row expose an explicit “打开档案” action. The detail dialog must show:
   - period, version, state, creation and lock metadata;
   - the full manifest SHA-256;
   - included reconciliation runs and their rule hashes;
   - source files and their SHA-256 fingerprints;
   - exact source/target allocation totals by original currency;
   - audit high-water mark and raw manifest JSON.
5. For an open version, show that no immutable evidence exists yet and explain that locking requires a compatible completed run with no open blocking exceptions.
6. Do not add fake XLSX, PDF, ZIP, or download buttons. Keep this limitation visible.
7. Preserve minor-unit integer handling, tenant isolation, role authorization, close idempotency, and immutable locked snapshots.

## Verification contract

- Full test suite passes.
- The close lifecycle integration test reads the archive through the new tenant-scoped query and proves cross-tenant access returns no record.
- Running `demo:seed` twice leaves exactly one locked version and one open version for the demo period.
- Auditor browser verification can open the locked archive, see a 64-character manifest, runs, files, totals, and no mutation controls.
- Desktop and 390px layouts have no horizontal page overflow and no browser console errors.

## Explicit limitations

This iteration provides an in-product evidence inspection view. Formal XLSX/PDF evidence-package generation, signatures, external object-storage publication, and archive download remain unimplemented.
