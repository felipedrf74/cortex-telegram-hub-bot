# Current Release State

> **Process changed 2026-08-07** — see [`continuous-deployment.md`](continuous-deployment.md).
> Signed state observed 2026-08-29; superseded snapshots remain in Git history.
> Authority: `sudo -n /usr/local/sbin/nexus-release-state-view`, backed by `/var/lib/nexus-release/state/release-state.json` and `/var/lib/nexus-release/receipts/`; `docs/release/release-state.json` is generated and non-authoritative.

## Current signed state — 2026-08-29

- Completed v3 receipt `f01e680bffd3b7d03d9a45a490aec45a` proves protected-main source `e9afc77cf1af6b3cece3022e0744bcc2dc27a689`, backend digest `sha256:a45fdcd8932a4839bfe1ce844879a18970928979184695a656588cdccbb3cfd7`, Content Engine digest `sha256:db72646164a1888096e26fdb5a760688d4c312dfa047e31eb498e8cd958586e5`, and signed payload digest `sha256:99acb8e7a3e9cee403c5aaef54a7ff7ad86f6fd502b76f6161b3746ce1815c63`. The receipt is completed, provable, and not stale.
- The serving source contains Release A migrations 297–301, all six script-job creation/completion release-identity writers, the isolated OpenAI Batch project binding, and the GPT-5.6 visible-output fix merged through PR #398. New GPT-5.6 Batch Chat Completions requests explicitly disable reasoning so bounded completion tokens remain available for contract-visible text; exact pre-pin durable stages retain their reviewed legacy envelope and digest.
- The immutable acceptance inventory remains exactly ten. A GET-only authenticated reconciliation by the reviewed successor-v4 acceptance tool atomically updated the mode-0600 private state at `2026-08-30T00:25:34+01:00`, with server-owned job metadata observed through `2026-08-29T23:25:21.775Z`. That snapshot records seven of nine pre-release scenarios completed with `contractPass=true`, one successor running, one successor queued, zero terminal failures, and one pending smoke. The same two successor identities consumed one authenticated same-job retry each; no replacement identity or additional scenario was created.
- On 2026-08-30 the owner explicitly removed those two scenarios as release blockers; this canonical entry is the durable repository record of that instruction. The exception does not convert them into passes, alter their private evidence, authorize another retry, or satisfy the 9/9 production-smoke gate. The smoke remains pending and unsubmitted. Acceptance evidence v6 and authenticated economics v7 therefore cannot produce a passing activation artifact from this inventory.
- Draft PR #389 is superseded because its launcher and successor-evidence contract require 9/9 and a source-bound smoke. It must not be merged or used to submit job ten under the exception path.
- App Store review and iOS release status are external to this backend-only closure and are not restated as current facts here. The last backend-canonical Apple evidence remains in the remediation log; fresh App Store Connect verification is required before any status or approval claim. Apple sales remain disabled until approval.
- Hybrid credits, subscription checkout, Stripe pack fulfillment, Apple sales, and production local-primary activation remain OFF. Deployment of guarded code is not activation evidence.

## Open activation evidence — 2026-08-30

- Public commerce remains blocked on the owner/accountant seller-identity and Portugal/OSS decision, applicable Stripe Tax registration, and counsel/owner approval of the repository Privacy Policy and Terms sources. Website copy is not approval provenance for those repository legal drafts.
- Apple approval, commission status, reviewer-path completion, and post-approval listing verification remain external. An iOS build must not be replaced merely because review is pending.
- The owner exception permits release closure with guarded defaults left OFF; it does not waive the cryptographic or measured gates for activation. Production smoke, acceptance v6, and a passing authenticated economics-v7 artifact remain absent by construction.
- Any economics execution under this exception must fail closed at the missing acceptance-v6 prerequisite. Public rates, synthetic traffic, or operator-entered summaries cannot replace actual-account measured-p95 evidence.
- Previously disclosed provider and VPS credentials were not copied into repository artifacts. Owner-controlled rotation or supersession evidence under plan Addendum D remains required before enabling commerce or production inference.

## Historical container lineage — 2026-08-19

- Every protected-main release mints a new receipt. Resolve the active chain with `nexus-release-state-view` and audit evidence with `nexus-release-audit-evidence`; never treat this projection as a frozen head.
- Detailed release, migration, acceptance-recovery, Apple, commerce, and activation history remains in [`hybrid-commerce-qa-remediation-log.md`](hybrid-commerce-qa-remediation-log.md), including the full receipt lineage, the `src/config.ts` two-step CD halt rule, QA4–QA6 findings, and kill-switch migration history.

## Release process

Protected-main CI publishes a signed OCI payload and image pair; the VPS poller runs staging, backup, migration, production observation, and recovery with immutable receipts. A merged pull request or green CI run is not production completion without the corresponding completed receipt.
