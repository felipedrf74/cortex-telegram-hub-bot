# Current Release State

> **Process changed 2026-08-07** — see [`continuous-deployment.md`](continuous-deployment.md).
> Signed state observed 2026-08-25; superseded snapshots remain in Git history.
> Authority: `sudo -n /usr/local/sbin/nexus-release-state-view`, backed by `/var/lib/nexus-release/state/release-state.json` and `/var/lib/nexus-release/receipts/`; `docs/release/release-state.json` is generated and non-authoritative.

## Current signed state — 2026-08-25

- Completed backend receipt `cec9cc171f8953e6e1191894dd3e1927` proves protected-main source `92b722ee02242fd37453ece17d74cfc53102d961`, backend digest `sha256:d019a44f9ebf9350a2739c57e716536cb02fc269a63ba78945aceaccb8f46abf`, Content Engine digest `sha256:db72646164a1888096e26fdb5a760688d4c312dfa047e31eb498e8cd958586e5`, and signed payload digest `sha256:a29c35a2aaba968b829607a54e187de29258c0bf46646cc08828af3454b93310`. The v3 receipt is provable and no release block is active.
- iOS 1.5.0 build 289 from protected-main source `3647dcf1447fa1530fe542dbf6bfb979398f1ad2` completed the Xcode Cloud App Store Release workflow and is assigned to internal TestFlight. App Store review submission `9f222cb7-fec9-47c9-988a-5f58cbe9184b` contains that build and the three consumables; all were `Waiting for Review` on 2026-08-25. The later app-level `Rejected` observation below supersedes that status without proving current per-item state or reason. Protected iOS `main` is `6ad5193c04be2199fe4ea84a76272468bf2bb72c` and carries unsubmitted build 290, which passed 28/28 device-compatible and 8/8 repository-source checks.
- The production website authority is [`https://nexushub.me/`](https://nexushub.me/). Source `2e2d44c` published as Pages deployment `c8bc468e`; PT/EN pages returned HTTP 200 with zero redirects and match catalog prices, allowances, and packs while purchases remain closed. Legal pages retain approved disclosures; App Privacy declares 14 data types.
- The real Apple sandbox path is closed: a signed transaction bound to the isolated staging account granted exactly 100 credits, replay returned `already_credited` without changing the balance, and the corresponding notification was durably processed once. Production Apple fulfillment remains OFF after the app-level rejection; current review detail, Small Business Program approval, and commission effective date remain external.
- The governed policy-v5 pass rejected GPT-OSS despite score `76.32`; it won `25%` of paired cases and failed safety/tenant, output-contract, latency, memory, and critical-skill gates. Its digest was removed. Qwen is the sole resident model; both gateways are healthy on Ollama `0.24.0` with the signed 8-CPU, 18GB/20GB, zero-swap envelope. The manifest remains `control_only`, so local-primary canary/active admission remains impossible.
- Hybrid credits, subscription checkout, and Stripe pack fulfillment remain OFF pending ten-script/economics evidence and unresolved seller Stripe Tax/legal-registration facts. The account reports `business_type=individual` and zero Tax registrations while legal pages name Cigarra Esbelta Unipessoal LDA. Support and legal URLs are configured; deployment is not activation evidence.
- The durable inventory remains exactly ten. At the latest metadata-only observation, seven of nine pre-release scripts were completed and contract-valid. The two owner-authorized retries reached the ordinary `2026-08-27T03:00:00Z` batch window, replayed immutable completed provider batches whose textual result was empty, and exhausted the legacy infrastructure-retry loop under `CONTENT_SCRIPT_INFRASTRUCTURE_RETRY_EXHAUSTED`. Both original identities are terminally failed with their validated progress preserved. Production smoke remains pending; no replacement, extra scenario, early movement, release-view capture, or smoke submission occurred.
- The release receipt prerequisite was re-proved for the exact backend source with no active block. The old v2 tool is forbidden for smoke; the reviewed, exclusively locked v3 migration cannot cross the incomplete nine-scenario pre-release gate.

## Open activation evidence — 2026-08-26

- Public commerce remains blocked on the owner/accountant seller-identity and Portugal/OSS decision, applicable Stripe Tax registration, and counsel/owner approval of the repository Privacy Policy and Terms sources. Website copy is not approval provenance for those repository legal drafts.
- A read-only App Store Connect check on 2026-08-26 reports Nexus Hub iOS 1.5.0 as `Rejected`, superseding `Waiting for Review`; the detail route did not finish loading. On 2026-08-27 both available browser surfaces redirected to Apple sign-in, the prior account tab recorded failed authentication, and no connector or repository CLI was available. The exact rejection detail thus requires an owner-authenticated session. Approval, commission, reviewer-path evidence, and post-approval listing verification remain external.
- The owner-approved recovery remains bounded to the two existing durable job identities and their scheduled semantics. Release A now includes a typed `OPENAI_BATCH_EMPTY_OUTPUT` boundary and advances the legacy exhausted job's durable generation identity on an authenticated same-job retry, preventing replay of the poisoned completed Batch. Release A must be published, governance-authorized, and receipt-verified before either job is retried again; the retry must retain the ordinary next-batch-window deferral. The ninth-pass prerequisite and production smoke remain incomplete until those same jobs finish and pass their contracts.
- The legacy `ExecStartPost` smoke marker is preserved under a disabled name,
  so the old bare-SHA tool cannot submit job ten. A live read-only schema check
  proved that source `92b722ee` lacks migration 299 and all six script-job
  creation/completion release-identity columns required by evidence v6. Its
  previously staged launcher/tool pair is therefore preserved in an
  owner-private obsolete directory and must not run. The smoke remains locked
  after 9/9 until a predecessor-compatible Release A writes those identities;
  a distinct reviewed tool commit must then bind job ten to Release A while it
  remains serving. The currently untracked 92b-pinned launcher and its test are
  therefore Release B material: preserve them, exclude them from Release A's
  commit and generated project map, then replace the pin only after Release A's
  exact SHA exists. The obsolete launcher's earlier incomplete-state invocation
  exited 75, left the acceptance-state digest unchanged, created no release-
  view file, and did not arm or submit the smoke.
- The actual-account rate card, measured acceptance artifact, independent
  no-critical-quality-regression review, and pre-release economics result do
  not yet exist. Public activation must not substitute public list prices or an
  unbound evidence-reference string.
- Local, unverified remediation closes audited 30-day script-material, 90-day
  inference-telemetry, 12-month audit, provider crash/retry cleanup, account
  erasure, invoice ownership/deletion-proof, evidence source/tool-closure,
  Apple grant binding, anonymous-claim sunset, coach privacy, and generic
  webhook ownership plus phased encryption-boundary gaps. Release A also adds
  explicit throttles to CodeQL-identified authenticated billing/portal routes;
  focused tests, type-check, strict mock/secret scans, and mutation gates pass.
  It remains absent from the completed receipt; a producer receipt plus exact
  committed bytes may bind its SHA without adding an acceptance scenario.
- Migrations 297–301 are deliberately predecessor-compatible phase-A schema.
  A read-only check of both authoritative container databases on 2026-08-26
  found `296_apple_foundation_models_device_lane.sql` as the latest governed
  filename and no ledger row for 297, 298, 299, 300, or 301. This proves no earlier
  draft under those filenames was applied. Release A keeps
  `WEBHOOK_OWNER_ENCRYPTION_WRITES_ENABLED=false`; only a later
  protected release may enable envelope writes and key rotation after a
  completed receipt proves the compatible rollback floor. Database-enforced
  contract constraints remain deferred until the predecessor is retired;
  phase A enforces those contracts in the runtime.
- The changed-scope migration scanner proves all five SQL files are
  predecessor-compatible, but the release is governance-only because it also
  changes the registered migration-packaging, release-data-maintenance
  configuration, and Finance maintenance implementation paths. Its exact
  current review subject is
  `5bb3268af5664db480fe8f6479810766cf9f04c76311242c4c6aa0f5c4b00de2`.
  Protected-main publication may proceed, but the ordinary poller must leave
  the candidate unsettled until an attended
  `--authorize-governance-only <exact-release-id>` invocation records the
  root-owned one-shot authorization after live-ledger reconciliation proves
  that every pending migration remains predecessor-compatible. This does not
  authorize contract or destructive SQL.
- The activation-evidence remediation now uses authenticated economics-v7
  evidence with embedded governed inputs and packaged-module byte checks.
  Migration 301 binds any durable production active row to that artifact and
  serving source, rejects authenticated artifacts outside the 24-hour
  activation window, and stores successor ACTIVE separately while preserving
  predecessor-readable OFF/0. A later release or predecessor code rollback is
  therefore effectively OFF until explicit owner reactivation. This remains
  local-only pending full risk-gate and release verification; it does not
  authorize activation.
- Payment-provider and VPS-access credentials were disclosed in operator chat.
  Neither was copied into this work. Both require separate owner-controlled
  rotation/supersession evidence under plan Addendum D before activation.

## Historical container lineage — 2026-08-19

- Every protected-main release mints a new receipt. Resolve the active chain with
  `nexus-release-state-view` and audit evidence with `nexus-release-audit-evidence`;
  never treat this projection as a frozen head.
- The full receipt lineage, `src/config.ts` two-step CD halt rule, QA4–QA6
  findings, closed live Stripe test-entitlement defect, credit-ledger admission
  proof, and six kill-switch migration history remain in
  [`hybrid-commerce-qa-remediation-log.md`](hybrid-commerce-qa-remediation-log.md).

## Release Process

Protected-main CI publishes a signed OCI payload and image pair; the VPS poller
runs staging, backup, migration, production observation, and recovery with
immutable receipts. PM2-era fallback history is above. Defect `3b275a72…` is
closed, but its evidence is not a container release receipt.
