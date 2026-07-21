# Irreversible Migration Contract

Status: canonical release policy
Owner: Felipe
Last verified: 2026-07-18

This file is an implementation and release contract. It does not claim that a
migration has run in staging or production. Current deployed truth remains in
`release-state.json`.

`config/irreversible-migrations.json` is the canonical machine-enforced
registry for this contract. Its v2 entries pin every governed migration and
syntax exemption to the SHA-256 of the exact reviewed SQL bytes. Release
verification and changed-area classification validate every registered path
and digest before applying policy. Missing paths, same-prefix renames, digest
drift, registry changes, and enforcement-path changes fail closed and require
review; an identity mismatch must be corrected in the reviewed registry before
the release gate can pass, even when approval and backup evidence exist. The
table below is the operator-readable explanation and must stay in lockstep with
the registry.

## Required release sequence

For every migration listed below:

1. Obtain explicit owner approval for the irreversible/state-coupled migration.
2. While the predecessor runtime and both database-owning processes are still
   online, create a consistent read-only SQLite online-backup clone on the same
   host. Apply the exact candidate's pending migrations with the canonical
   migration runner, then run integrity, foreign-key, and every Content exit
   and readiness assertion. Any unsupported scope, broken tenant chain,
   unbound active row, missing writer guard, already-migrated source, or clone
   cleanup failure blocks promotion before downtime.
3. Bind the aggregate-only online rehearsal record to the predecessor and target
   runtime SHAs, target version, artifact, review and policy identities,
   one-time promotion run, exact migration-set identities, and source/migrated
   clone digests. Raw database rows and content never leave the server; the
   private clone, WAL, SHM, rollback journal, and residual sidecars are removed
   before evidence is emitted. Evidence paths are canonical, private `0600`,
   run-unique, and created with atomic no-overwrite semantics.
4. Drain writes, checkpoint the SQLite WAL, run integrity checks, and capture a
   verified database snapshot inside the exact predecessor release backup.
   Then rerun the same exact migration and readiness checks against a fresh
   clone of that quiescent database. The final rehearsal source digest must
   equal the archived database digest; legitimate writes since the online
   rehearsal are allowed and do not require the two source digests to match.
   The stopped-state backup record must bind both fresh rehearsal records.
5. Promote the exact compatible runtime and migration together. Do not run an
   old writer against the migrated database.
6. Monitor readiness, compatibility-traffic, guard-block, conflict, failure,
   and kill-switch aggregates for the declared observation window.
7. If recovery is required after state-bearing use, restore both the exact
   predecessor runtime and the exact pre-migration database snapshot. A code-
   only downgrade and an inverse SQL reconstruction are unsupported.

## Review and promotion evidence boundary

Review approval and backup proof are deliberately separate because the exact
rollback snapshot cannot exist while pull-request and pre-commit checks run.
The changed-only migration gate has three deliberately distinct modes:

- `--approval-mode scan` is non-authorizing. It validates migration sequence,
  cumulative apply, registered SQL identities, and the exact changed-path
  subject, then returns `authorization.approvalRequired: true` and
  `authorizesPromotion: false`. It never treats a missing approval or backup as
  evidence and cannot be used by release preparation or promotion.
- `--approval-mode review` validates the governed SQL identities, the exact
  sorted set of irreversible/governance paths, each changed path's candidate
  SHA-256 (or deletion marker), and an owner approval artifact under
  `.local/release/migration-review/`. The artifact uses schema
  `nexus.migration-review-approval.v1` and binds `approvedBy`, `approvedAt`, and
  `status: approved` to the gate's `requiredReviewSubject.sha256`. It does not
  claim that a database backup exists. Unregistered destructive migrations are
  rejected even when an approval artifact is present.
- `--approval-mode promotion` revalidates that same approval artifact and also
  requires fresh online and stopped-final
  `nexus.production-shape-migration-rehearsal.v2` records plus
  a later `nexus.exact-migration-backup-evidence.v2` record under
  `.local/release/production/`. The record binds the predecessor and target
  runtime SHAs, target version and artifact, one-time promotion run, policy
  subject, approval-artifact and rehearsal digests,
  remote archive path, archive SHA-256 and size, and the stopped-owner, closed-
  handle, WAL-checkpoint, SQLite-integrity, foreign-key, and archive-digest
  proofs.

The rehearsal also validates `config/production-migration-lineages.json`.
Databases with no retired rows use the canonical lineage. A deployed lineage
may retain only an exact, artifact-signed set of historical filenames whose
original SQL identity, provenance, and canonical replacement are recorded in
that policy. Unknown extras, partial retired sets, executable retired SQL,
replacement drift, or a gap in the remaining canonical prefix fail before the
production stop. Rehearsal evidence binds the policy digest and selected
lineage; production ledger rows are never deleted to manufacture compatibility.

The canonical promotion script creates and validates one production-shape
rehearsal while both database owners remain online and before its stop marker.
It writes the strict backup record only after both
database-owning PM2 processes are stopped and the remote backup helper returns
a verified archive, a second rehearsal against the stopped source passes, and
that source's database digest equals the archived database digest. It runs the
promotion-mode gate before setting the
candidate-mutation boundary or starting the new runtime. If this gate fails,
the untouched predecessor is restarted. Arbitrary strings, an older release
backup, a stale or replayed rehearsal, a wrong-source clone, and source-
controlled approval identities are not accepted evidence.

An ordinary PR or local risk scan may use non-authorizing scan mode. The release
review artifact is delivered through an owner-controlled channel and stored
only under the ignored evidence directory. Local review uses
`NEXUS_MIGRATION_REVIEW_EVIDENCE` or the ignored default
`.local/release/migration-review/current.json`. Missing approval remains an
expected blocking result; do not bypass it by inventing an approver or copying
an unrelated artifact.

## Content workspace migrations

The complete Content workspace schema sequence is migrations 239 through 253.
The table lists the subset whose state-coupled cutover or integrity boundary
requires the strict snapshot rollback contract above; additive predecessors
still run in sequence and remain part of the same release artifact.

| Migration | Reviewed SHA-256 | Irreversible boundary | Down-script contract | Removal gate |
| --- | --- | --- | --- | --- |
| 246 `content_pipeline_workspace_exit` | `9d8dc3f80ee536a4b5315073c2918adcf74714bece6f7d5862fab27de20486f9` | Canonical ingress bindings, revisions, approvals, schedules, or agent work may exist after cutover. | Runs only when the binding ledger is empty; otherwise exact pre-246 snapshot. | Full lineage parity, supported-client adoption, zero compatibility traffic for two supported release windows, and completed recovery drill. |
| 247 `content_topics_workspace_exit` | `26709f5a36f5a878886a04e2ed1066078ea44cb0933f4f043992b616aec8d8f1` | Topic writes become canonical items/artifacts and legacy dates become deadline-only truth. | Runs only for untouched backfill rows with no subsequent canonical work; otherwise exact pre-247 snapshot. | All eligible rows linked, no supported legacy mutator imports, zero compatibility traffic, export/erasure proof, and elapsed deprecation window. |
| 249 `content_editorial_workspace_exit` | `f8131667068a6df7627865aef31b18b284da02feeb1cebd06ee3e2d16cbec386` | Private noncanonical roots are normalized and old approval/source ledgers become historical. | Runs only when the editorial exit binding table is empty; otherwise exact pre-249 snapshot. | Canonical Decision targets, zero compatibility traffic for two supported releases, and verified historical-ledger export/legal erasure. |
| 250 `content_performance_workspace_lineage` | `f1d911796a075ac5ee77a0d3caf0f1a208cfb0893f85bcc522d868368bd01893` | New outcomes require immutable revision links and the legacy pipeline alias is frozen. | Always refuses inverse SQL; exact pre-250 snapshot is required. | All supported writers use canonical revision identifiers, metadata-only historical rows are reconciled or explicitly retained, and no compatibility writer remains. |
| 251 `content_workspace_integrity` | `6d698d4df580193c96fd0d5771e26a772f965fabfdd1e2c975d8e5e936a54fcf` | Revision ancestry, current selections, and accepted agent-result lineage become database-enforced and erasure-authorized. | Always refuses inverse SQL; exact pre-251 snapshot is required. | Preflight has no invalid pointers, all supported writers satisfy the stronger guards, account/legal-erasure rehearsal passes, and no older runtime can write the database. |
| 252 `content_legacy_script_workspace_parity` | `214fcf84726b7db27e9f873890b3c50e08f1e9f7b4e3e41c38788928faed6311` | Every eligible private legacy script body is copied byte-for-byte into a canonical script revision and immutable ingress binding before positive-user legacy writes are frozen. | Runs only when every binding still matches its migration snapshot and no bound canonical object has changed; otherwise exact pre-252 snapshot. | Exact body/hash/scope parity is green, voice learning reads canonical revisions, all supported positive-user writers use workspace capture, and legacy script read traffic is zero for the declared observation window. |
| 253 `content_legacy_idea_note_workspace_parity` | `d94448b6a42a94a27425225adbf8293a93040566f29450129a6268f8abaf265f` | Every eligible legacy `content_idea` note is copied byte-for-byte and every eligible scoped `saved_ideas` row is copied with an exact metadata snapshot into separate immutable canonical bindings; excluded rows are reason-coded and both alternate writers are frozen. | Runs only while both binding ledgers are empty; once either source is bound, recovery requires the exact pre-253 snapshot. | Note byte parity, saved-idea snapshot parity, independent tenant/owner scope, quarantine coverage, canonical capture adoption, export/erasure rehearsal, and zero legacy idea-root traffic are all green for the declared observation window. |

## Reviewed syntax exemption

Migration 248 contains destructive-looking table replacement syntax but was
reviewed as a lossless metrics-table rebuild and passes the cumulative
rehearsal. The exemption applies only to SQL with SHA-256
`3fd0e7124a2cd1c26639fa6283d0a39612bc1849171a42b68647d40c3effd58d`.
Any byte change revokes the exemption, marks the migration irreversible, and
fails policy identity until the new SQL and digest receive review together.

## Preflight evidence

The release artifact must retain machine-readable proof of:

- exact runtime SHA and bundle digest;
- predecessor release identity and database-snapshot checksum;
- migration rehearsal, `foreign_key_check`, and readiness results;
- online-backup source/candidate migration-set identities, source and migrated
  clone digests, cleanup proof, and one-time promotion-run binding;
- counts of blocked/unsupported rows requiring reconciliation;
- writer-guard inventory;
- supported-client capability and compatibility-traffic state;
- owner approval identity and timestamp.

Raw production rows and user content must not be copied into Markdown or logs.
Store governed evidence under the ignored release-evidence paths described in
`release-evidence-contract.md`.
