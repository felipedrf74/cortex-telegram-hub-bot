# Current Release State

> **Process changed 2026-08-07** — see [`continuous-deployment.md`](continuous-deployment.md).
> Signed state observed 2026-08-30; superseded snapshots remain in Git history.
> Authority: `sudo -n /usr/local/sbin/nexus-release-state-view`, backed by `/var/lib/nexus-release/state/release-state.json` and `/var/lib/nexus-release/receipts/`; `docs/release/release-state.json` is generated and non-authoritative.

## Final implementation anchor — 2026-08-30

- A completed, provable, non-stale v3 receipt proves protected-main source `02da8e27a31c39d24887f6fa40f816ecad694e38` and its exact signed image pair. Fresh live verification matched that source to the backend runtime and healthy three-service production topology.
- The serving source contains Release A migrations 297–301, all six script-job creation/completion release-identity writers, the isolated OpenAI Batch project binding, the GPT-5.6 visible-output correction, and the transaction-bound PM2 control-plane successor. Production SQLite passed integrity and foreign-key checks; migration 299 is present exactly once and all six live release-identity columns exist.
- The root-owned PM2 retirement journal completed under its exact successor authorization. The terminal v2 receipt, closure manifest, and successor evidence validate; PM2 executable authority, package prefix, root attestation, canonical units, and wants are absent, while permanent masks keep the retired path inert. Required release, heartbeat, backup-liveness, backup, and restore-verification timers are active and enabled.
- The immutable acceptance inventory remains exactly ten: seven of nine pre-release scenarios are contract-valid, the same two preserved scenarios are not contract-valid, and the production smoke is pending and unsubmitted. The owner exception removes those two scenarios as release blockers but does not convert 7/9 into 9/9, authorize more provider work, or satisfy acceptance v6 or authenticated economics v7. The acceptance timer is therefore intentionally inactive and disabled.
- Draft PR #389 is superseded because its launcher and successor-evidence contract require 9/9 and a source-bound smoke. It must not be merged or used to submit job ten under the exception path.
- Fresh App Store Connect and public-store verification on 2026-08-30 proves Nexus Hub iOS 1.5.0, Build 300, is ready for distribution and publicly listed. This clears the app-review/listing gate only; Apple commerce remains disabled because the backend fulfillment, credential, legal, acceptance-v6, and economics-v7 activation gates below are still open.
- Hybrid credits, subscription checkout, Stripe pack fulfillment, Apple sales, and production local-primary activation remain OFF. Deployment of guarded code is not activation evidence.
- The retained local control model is `qwen2.5:3b-instruct-q4_K_M` under manifest `qwen2.5-3b-control`; it remains benchmark/control-only while local-primary routing is OFF.

## Open activation evidence — 2026-08-30

- Public commerce remains blocked on the owner/accountant seller-identity and Portugal/OSS decision, applicable Stripe Tax registration, and counsel/owner approval of the repository Privacy Policy and Terms sources. Website copy is not approval provenance for those repository legal drafts.
- Apple app review and public-listing verification are complete. In-app-product sale status, commission/account terms, and backend fulfillment activation remain external/account-bound gates; do not enable Apple sales or replace the approved build while those gates remain open.
- The owner exception permits release closure with guarded defaults left OFF; it does not waive the cryptographic or measured gates for activation. Production smoke, acceptance v6, and a passing authenticated economics-v7 artifact remain absent by construction.
- Any economics execution under this exception must fail closed at the missing acceptance-v6 prerequisite. Public rates, synthetic traffic, or operator-entered summaries cannot replace actual-account measured-p95 evidence. The release is closed with guarded defaults; commerce and inference activation remain NO-GO.
- Previously disclosed provider and VPS credentials were not copied into repository artifacts. Owner-controlled rotation or supersession evidence under plan Addendum D remains required before enabling commerce or production inference.

## Moving release lineage

- Every protected-main release, including documentation-only successors, mints a new receipt. Resolve the active chain with `nexus-release-state-view`, require the serving source to contain the implementation anchor above by ancestry, and never treat this projection as a frozen head.
- Detailed release, migration, acceptance-recovery, Apple, commerce, and activation history remains in [`hybrid-commerce-qa-remediation-log.md`](hybrid-commerce-qa-remediation-log.md), including the full receipt lineage, the `src/config.ts` two-step CD halt rule, QA4–QA6 findings, and kill-switch migration history.

## Release process

Protected-main CI publishes a signed OCI payload and image pair; the VPS poller runs staging, backup, migration, production observation, and recovery with immutable receipts. A merged pull request or green CI run is not production completion without the corresponding completed receipt.
