# Open Items

Status: canonical
Owner: release lead (Felipe)
Last verified: 2026-05-07
Update policy: update when a current carryover opens or closes. Monthly
historical detail for the 2026-05 tech-debt sweep lives in
`docs/release/OPEN_ITEMS_ARCHIVE_2026-05.md`.

Last sweep complete: 2026-05-07.
Closeout dossier:
`engine/docs/archive/2026-05/tech-debt-validation/sweep-closeout-dossier.md`.

## Standing Authorizations

- `BATCH-24-CLOSEOUT-AUTHORIZED`: honored by Batch 24 U1/U2/U5.
- `BATCH-24-CLAUDE-MD-PRODUCTION-TRUTH-UPDATE-AUTHORIZED`: honored as staged
  text only at `docs/release/staged-claude-md-update-after-2026-05-deploy.md`;
  `CLAUDE.md` was not modified.
- `BATCH-24-OPEN-ITEMS-ROTATION-AUTHORIZED`: honored manually because
  `engine/scripts/rotate-open-items.mjs` was absent in the Batch 24 checkout.

## Operator-Only Carryovers

These require Felipe/operator action and are not Codex-closable without live
credentials, devices, or deployment authority.

- Push local `main` to `origin/main` after Felipe's merge review.
- Deploy staging and run staging smoke.
- Promote production and run production health.
- Signed TestFlight and two-account walkthrough.
- APNs validation.
- Real Gmail/Outlook/Health provider-state checks.
- Non-prod Google/Outlook OAuth credentials provisioning.
- Garmin MFA/live-session validation, which remains the closure path for P2-35.
- Content portal smoke window.
- iOS fastlane setup, if Felipe chooses to pursue it.
- Self-hosted runner provisioning, only if SSH-only promote workflows require it.

## Authorization-Gated Codex Workstreams

These are Codex-addressable but remain deferred until Felipe explicitly
authorizes the next batch.

| Queue | Status | Notes |
|---|---|---|
| Batch 25 | pending authorization | Content lifecycle unification phase 1: audit and plan. |
| Batch 26 | pending authorization | Content lifecycle schema migration phase. |
| Batch 27 | pending authorization | Content lifecycle service/API migration phase. |
| Batch 28 | pending authorization | Content lifecycle iOS/Python contract and cleanup phase. |

## Evidence Gaps

- Batch 17 iOS P2 remediation report was not reconstructable in the Batch 24
  archive pass. Revalidation exists at
  `docs/archive/2026-05/tech-debt-validation/codex-batch-17-revalidation.md`.
- Batch 1 does not have a standalone remediation artifact; evidence is
  preserved in
  `docs/archive/2026-05/tech-debt-validation/codex-tech-debt-pass.md` and
  `docs/archive/2026-05/tech-debt-validation/codex-validation-matrix.md`.
