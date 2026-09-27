# Exact UI patch approvals

`ui-baselines/approved-change-manifest.json` is the immutable historical
approval from `029464c77fd8f1299e9a91f45326afc83a909e2e`. It is an exact
patch attestation, not a reusable source baseline. Do not edit or replace it.

New approvals are additive JSON files in `ui-baselines/approved-changes/`.
Name each file `<sha256-of-the-file-bytes>.json`; do not rename or edit an
existing record. Each new record uses schema version 1 and must contain the
exact base commit (`base.sourceCommit`), candidate commit
(`target.sourceCommit`), exact `allowedFiles`, `expectedTextChanges`,
`expectedDiffSha256`, and `expectedDiffLines`. The target commit must contain
only the approved files. Create and review the candidate commit first, then
record its exact diff and file hash in a new approval file. Approval is a
separate reviewed action.

The UI guard discovers the historical record and all content-addressed records
automatically. It validates every record, then requires exactly one match for
the complete candidate diff; zero or multiple matches fail. For a committed
candidate, set `UI_SOURCE_COMPARE_REF` to its approved base when running
`npm run predeploy` so the guard compares that commit range. No approval-file
selector is needed. `UI_APPROVED_CHANGE_MANIFEST` still accepts an explicit
safe record path, but cannot suppress other discovered records or resolve an
ambiguous match. The former substitution behavior was unsafe once multiple
records became possible. Never use an override to replace historical evidence.
