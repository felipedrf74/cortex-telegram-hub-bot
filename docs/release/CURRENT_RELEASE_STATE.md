# Current Release State

Machine-readable truth: `docs/release/release-state.json`.

## Production

- Backend version: `4.14.230`
- Runtime commit: `36b96fab8d0987696ccd7e2ca35a343bca32da2f`
- Artifact digest: `07a09ffc1dd608710f203493a3bee244c296b2d8126adb5916a5427b28d0de05`
- Installed digest: `df54eea21739749e454153d931cfa01c953d5477f458009483fe4340b7be4aa6`
- Training catalog package: `51c1089cceb8a916abf200b5cb3688b19f5f7553990467ee0f8ef01c7c4f74bb`
- Training release subject: `27b97ebc96e1b3bb1ee3612e63c5609b5572c9d4b58e59b8ea3e77642fb1cea3`
- Completed at `2026-07-22T08:37:34.234Z` with an 81-second cutover.
- Backend health, database connectivity, media origin, PM2 process identity,
  staging parity, and exact installed-tree identity are healthy.
- Exact rollback backup:
  `v4.14.224_before-v4.14.230_20260722_093618.tar.gz`.

## Artifact-Bound Evidence

- Release candidate run: `29876582985`
- Protected signing run: `29878221235`
- Staging run/request: `29878760031` /
  `0a901fee-876d-44e6-ba36-fee8cf273d4a`
- Evidence remains under ignored `.local/release/` paths and restricted CI
  artifacts; this summary is not reusable promotion evidence.

## iOS / TestFlight

- iOS version/distributed build: `1.5.0` (259), from source build 59.
- Archived binary source: `f3d868783a52f549c235b11dc0a378fa7adfc43b`
- Final archive-signing PR head: `213e40d08edc84732079c08b1515312b9e9efb30`
- iOS `main`: `7fd4e96e2e0d2b51587777c0454698ea8a3b8b3f`
- IPA SHA-256: `5eeb35d43ae24fb16ef7d5bb631e8bbbdbe866f527150073a3dcdbf7a74bb2c8`
- Archive binary SHA-256: `b6f0215fab51f0d4d193cd4102e6c542bb56520e65669486af42aa117a1db7b5`
- Distribution attestation SHA-256:
  `35ebc4d1e2a27fc9d09e8ad089409191fc3b01b5e352bcc81c3ee53ff564452d`
- Xcode 26.6 / iPhoneOS 26.5 produced the validated Apple Distribution binary.
- Build 259 is available to the `Nexus Hub Betinha` internal TestFlight group.
  Builds 54-57 remain retained; physical-device smoke for build 259 remains
  open.
- App Store review outcome for build 259: **rejected on 2026-07-24** under
  Guideline 2.1(b) (subscription products were not submitted with the version,
  while the client rendered an empty StoreKit catalog as indefinite loading)
  and Guideline 5.1.1(v) (the existing deletion flow was not discoverable from
  the ACCOUNT section). `release-state.json` still records
  `appStoreReviewState` as `waiting_for_review` and automatic release after
  approval; refreshing those fields is a pending owner action, not a verified
  state this summary may assert.

## In-Flight Remediation, Not Released

- Branch: `claude/appstore-review-fixes-20260727`, on both the backend and the
  iOS repository, cut from their respective `main` heads.
- Status: **locally compiled, not staged, not promoted, not resubmitted.** No
  release candidate, signing run, staging attestation, iOS archive, or release
  verification verdict exists for this work.
- Locally observed on 2026-07-27:
  - iOS Release simulator build: succeeded with
    `CURRENT_PROJECT_VERSION = 59`.
  - iOS unit tests: not executed because the managed runner could not connect
    to CoreSimulator; `xcodebuild test` exited 70 before test bootstrap.
  - Backend TypeScript: `npx tsc --noEmit` exited 0 under Node 22.23.1.
  - Backend changed/new focused Vitest gate: passed for every selected test
    file that does not require a local listener.
  - Backend migration safety: `node scripts/migration-safety-check.mjs`
    passed.
  - Backend full Vitest: not green in the managed runner. The dominant failure
    was sandbox-denied local listening on `127.0.0.1` or `0.0.0.0`; this result
    cannot be promoted as release evidence and requires an unrestricted rerun.
- Owner-side steps that no code change can satisfy — App Store Connect product
  and agreement configuration, reviewer demo-account entitlement, review notes,
  the deletion screen recording, and the production freeze during review — are
  in `docs/release/app-store-submission-runbook.md`.
- Behavior change to expect on promote, beyond the two rejection fixes:
  `revokeOneThirdPartyProvider` in `src/services/user-data-export.ts` now runs
  `clearGarminSession` and the local `getTokens` read inside its error
  boundary. `DELETE /api/v1/connections/:provider` consequently no longer
  returns HTTP 500 when a local credential read throws during revocation; it
  completes the disconnect and reports `revocation.status = "failed"` in the
  success payload. Contract-wise this is additive — the response shape is
  unchanged — but a monitored 500 on that route will stop firing.

## Release Process

Ten signed staging attestations and six owner-authorized production releases
now prove the signed `ReleaseManifestV2`, immutable staging install, exact-artifact
promotion, atomic PM2 switch, and automatic exact rollback path.
The exact-artifact test, manifest, versioned-release, and documentation path is
the canonical release process. Its legacy repository-sync wrappers are now
retired. The signed root-owned promotion transaction is the sole runtime or
database mutation path for promotion and predecessor recovery. The legacy
`scripts/rollback.sh` and `scripts/restore.sh` commands remain available only
for read-only dry-run inventory; their apply modes are retired.

Every future production deployment, remote branch cleanup, and TestFlight
expiry still requires explicit owner authorization.
