# App Store Submission Runbook

Status: canonical
Owner: release owner (Felipe)
Last verified: 2026-07-27
Update policy: update when the App Store review outcome, subscription product
identity, reviewer entitlement mechanism, or reviewer demo-account contract
changes.

Apple rejected iOS `1.5.0` build 259 on 2026-07-24 under Guideline 2.1(b) — the
binary references subscriptions whose in-app purchase products were never
submitted, so the paywall never leaves its loading state — and Guideline
5.1.1(v) — the app supports account creation with no in-app account-deletion
path.

Code remediation is in flight on the `claude/appstore-review-fixes-20260727`
branch of both the backend and the iOS repository. This runbook covers only the
half that no code change can satisfy: App Store Connect configuration, reviewer
account provisioning, and production posture during the review window.

This file is a sequence and evidence definition. It is not authorization to
mutate production, Cloudflare, App Store Connect, or the App ID, and it does not
assert that any remediation is deployed. Runtime truth stays in
`docs/release/release-state.json`; the human summary stays in
`docs/release/CURRENT_RELEASE_STATE.md`.

## App Store Connect

Work these in order. Item 1 gates every other item on this list.

1. **Paid Applications agreement must be Active.** Business → Agreements, Tax,
   and Banking. While that agreement is pending, expired, or missing its bank or
   tax record, StoreKit's `Product.products(for:)` returns an empty array with
   no thrown error, which is precisely the stalled "Preparing Nexus Hub plans"
   state Apple screenshotted. Change nothing else until this row is green.
2. Confirm the app record before touching products: bundle id `me.nexushub.app`,
   Apple ID `6762022696`, team `B6885R8NWM`. These are the values pinned in the
   iOS repository's `ci_scripts/distribution-policy.json`. Products created
   under a sibling app record are invisible to this binary.
3. Create or confirm the subscription group that holds every product, with a
   group display name and an explicit rank per product.
4. Verify each product identifier character-for-character against
   `Nexus Hub/Core/SubscriptionManager.swift`: `me.nexushub.pro.monthly`,
   `me.nexushub.pro.yearly`, `me.nexushub.max.monthly`,
   `me.nexushub.max.yearly`. They are deliberately not namespaced beneath the
   bundle id, so a typo and a not-yet-approved product are indistinguishable
   from the client: both yield an empty product array.
5. Per product, confirm at least one localization with display name and
   description, a price schedule covering every storefront the app ships to, and
   an attached review screenshot. The screenshot is mandatory and is the field
   most often left blank. Each product must read **Ready to Submit**.
6. **Attach every product to the 1.5.0 version submission.** This is literally
   what the 2.1(b) rejection text says was missing; products can be Ready to
   Submit and still not be part of the version submission.
7. App Information → License Agreement: either file the custom EULA that the
   paywall already links (`https://nexushub.me/termos`, with the English variant
   at `?lang=en`) or switch the app to Apple's standard EULA. Confirm the
   subscription group's Privacy Policy URL resolves; the app links
   `https://nexushub.me/privacidade`.
8. **Demo account: use Sign in with Apple or Google, never email/password.**
   `POST /api/v1/auth/register/apple` and `.../register/google` have no invite
   gate. The email path additionally triggers a verification-code sheet, and
   `POST /api/v1/auth/send-verification` returns HTTP 503 `EMAIL_UNAVAILABLE`
   when SMTP is unconfigured, which strands a reviewer on a cold launch. The
   invite-code arrow in item 9 Path A is the third acceptable entry point — it
   is device-bound and touches neither SMTP nor a social identity. Whichever
   entry point the Review Notes name, name exactly one.
9. **Pre-grant the reviewer account a paid entitlement server-side.** Without
   it, Training, Content, Cooking, and Finance stay locked and the reviewer's
   only exit is the paywall Apple already flagged. Two mechanisms work. They
   are not equivalent, and a third one that looks like it should work does not
   — read the warning at the end of this item before doing anything.

   **Path A — invite code plus the arrow button. Self-service; no owner action
   during the review window.** Mint a database invite code through the portal
   (`POST /api/invite-codes` in `src/portal/invite-routes.ts`, bearer
   `authorization` against the portal admin token, portal bound to
   `127.0.0.1:8200` by default) with body:

   ```json
   { "maxUses": 5, "expiresInDays": 60 }
   ```

   Both fields matter. `maxUses` **defaults to 1**, so a code minted with an
   empty body is spent by the reviewer's first tap and every retry after that
   one fails. 60 days outlives the review window and a resubmission.

   `createInviteCode` returns 22 characters of `base64url`, and
   `validateAndConsumeInviteCode` matches the raw trimmed string — the code is
   **case-sensitive and may contain `-` and `_`**. Paste it into Review Notes
   verbatim so the reviewer copies rather than retypes it.

   The reviewer instruction must be exact: tap **"Have an invite code?"** at the
   bottom of the sign-in screen, type the code, then tap the **→** arrow. The
   arrow is the only control that uses the code. It calls
   `POST /api/v1/auth/register`, which consumes one use, creates a device-bound
   account, and applies `grantBetaSandboxAccess`.

   Do **not** instruct the reviewer to type the code and then tap Sign in with
   Apple or Google. Build 259 does not send `inviteCode` on either social route
   (`registerWithApple` / `registerWithGoogle` in
   `Nexus Hub/Core/AuthManager.swift` send no such field), so the typed code is
   silently discarded and the account lands on Free. Conversely, if the code has
   already been spent, the arrow returns HTTP 403 `INVALID_INVITE` — which is
   the reason for `maxUses: 5`.

   What Path A actually grants: `subscriptions` gets
   `plan='max', status='trialing', provider='beta'`, which
   `getEffectiveEntitlement` (`src/services/entitlement.ts`) normalizes to plan
   `beta` / source `beta` with `aiAccessAllowed: false`. Secretary, Training,
   Content, Finance, and Cooking unlock; `connections`, `notifications`, and
   `decision_center` do not (`config/capability-manifest.json`). Model calls
   still run **only because paid-AI cost control is observe-only by default** —
   item 14 is therefore a hard dependency of this path, not merely a freeze
   precaution. Coach briefings and Nexus Points stay off regardless:
   `isCoachBriefingEntitlementEligible` excludes `source === 'beta'`
   unconditionally.

   **Path B — founder grant. Full entitlement; needs one owner action once the
   account exists.** `POST /api/founders` (`src/portal/founder-routes.ts`) with
   `{"email": "<the account's email>", "plan": "max"}`. `addFounder` writes the
   founders row and calls `syncFounderSubscription`, which writes
   `plan='max', status='active', provider='founder', current_period_end=NULL`.
   That resolves to source `founder` with `aiAccessAllowed`,
   `automationAllowed`, and `nexusPointsAllowed` all true, unrestricted skills,
   and coach briefings eligible — strictly more than Path A, and with no
   dependency on item 14. Two constraints:
   - It matches on `users.email`, so it is a **no-op until the account
     exists**. `createAuthSessionAndRegisterDevice` re-checks the founders table
     on every session issuance, so a row added before the reviewer signs in
     applies at sign-in, and a row added afterwards applies immediately.
   - For Sign in with Apple the email is whatever the account was created with.
     If the reviewer uses **Hide My Email** that is an
     `@privaterelay.appleid.com` address nobody can know in advance; read it
     from the portal's `GET /api/users` after the reviewer's first sign-in. A
     Path A device account has no email at all and can never receive a founder
     grant.

   **`PUT /api/users/:userId/tier` grants nothing — do not use it.** It runs
   only `UPDATE users SET tier = ?` (`src/portal/user-routes.ts`), and
   `getEffectiveEntitlement` never reads `users.tier`: it resolves from the
   `subscriptions` table, and its owner check explicitly passes
   `allowPersistedTier: false`. An account set to `tier='max'` this way still
   resolves to Free with `blockReason: 'plan_required'`, and the reviewer still
   meets the paywall.
10. Review Notes must state, at minimum:
    - the exact deletion path — Settings → ACCOUNT → Delete account → Delete
      everything — verified against the build actually uploaded, not against
      this document;
    - that the demo account is pre-provisioned so no purchase is required to
      exercise the reviewed features — stated for the path actually used in
      item 9, not generically. Path B (founder) is the only one where "holds a
      paid entitlement" is true; on Path A the resolver reports plan `beta`,
      Connections/Notifications/Decision Center stay locked, and coach
      briefings and Nexus Points are off, so claim only "no purchase is
      required" and list what the reviewer can reach;
    - that Garmin, Google, Outlook, and Apple Health connections are optional
      and skippable during onboarding;
    - that Garmin exposes no consumer OAuth API, so credentials are exchanged
      over TLS for an encrypted session token and are not retained as a
      password. State this pre-emptively; it is the usual trigger for a 5.2.2
      follow-up.
11. Attach a screen recording of the complete deletion flow. Apple asked for
    this explicitly in the 5.1.1(v) finding.
12. Export compliance is already answered inside the binary:
    `ITSAppUsesNonExemptEncryption` is set in `Info.plist` and asserted by
    `Nexus HubTests/PrivacyManifestTests.swift`. If App Store Connect still
    reports "Missing Compliance", the archive did not come from the reviewed
    tree.
13. **Do not touch the build number.** Xcode Cloud stamps `CFBundleVersion` from
    `CI_BUILD_NUMBER` — that is where 259 came from — and issues the next value
    automatically. `CURRENT_PROJECT_VERSION` stays at 59:
    `ci_scripts/distribution-policy.json` pins `buildNumber` to it and
    `ci_scripts/ios_distribution_evidence.py` asserts the source build both
    before and after archiving, so bumping it hard-fails the archive at two
    gates. Do not upload through `scripts/testflight-export.sh`; the protected
    `App Store Release` Xcode Cloud workflow is the only distribution path that
    produces a signed `nexus.ios-distribution-attestation.v2`.
14. **Freeze production between submission and approval.** No promotes, no
    environment changes, and specifically do not set
    `PAID_AI_COST_CONTROLS_ENFORCEMENT_ENABLED=true` — enforcement mode would
    return 403 for the reviewer's AI calls. See `docs/TOKEN-QUOTA-CONTRACT.md`
    for the observe-only default. If the reviewer was provisioned through
    item 9 Path A, this is load-bearing rather than precautionary: that grant
    resolves to `aiAccessAllowed: false`, and the reviewer's model calls
    succeed only while enforcement stays observe-only. Item 9 Path B does not
    carry that dependency.

## Pre-submission production readiness

The reviewer's entire session runs against one VPS behind a Cloudflare Tunnel
with PM2. Verify, do not assume:

- The production connector runs as the reviewed `nexus-cloudflared.service`
  systemd unit rather than as detached user processes. Migration steps, the
  two-phase installer contract, and its evidence rules are already canonical in
  `docs/security/security-operations-runbook.md` under **Durable cloudflared
  connector**; the unit and route template live at
  `ops/cloudflared/systemd/nexus-cloudflared.service` and
  `ops/cloudflared/config.yml.example`. Any migration needs its own approved
  Cloudflare operations window and must not overlap the review window.
- PM2 boot resurrection is intact. `scripts/remote-release-boot-health.sh`
  proves the real resurrect path against the root-installed
  `nexus.pm2-root-install.v1` attestation and a canonical sanitized dump;
  `scripts/remote-start-sanitized-pm2.sh` is what keeps that dump secret-free.
- An external monitor watches `https://api.nexushub.me/public-status` for the
  duration of the review window. That path is the only externally allowlisted
  route at the edge, and `scripts/cloudflare-edge-verify.sh` already asserts the
  monitor and AI user-agent exceptions. Do not add diagnostic fields to the
  payload to make monitoring richer; the WAF exception depends on it staying
  minimal.
- The App ID still carries Push Notifications, Time Sensitive Notifications,
  HealthKit, and Sign in with Apple. The entitlement files are
  `Nexus Hub/Nexus Hub.entitlements` and
  `Nexus Hub/Nexus Hub.Release.entitlements`; the release variant is what an App
  Store build must resolve to, because the debug variant targets the APNs
  sandbox and must match the backend's `APNS_ENVIRONMENT`.

## Known-risk items to answer if asked

- **Guideline 5.2.2, Garmin credential collection.** Garmin publishes no
  consumer OAuth API for Connect data. The app collects credentials once,
  exchanges them over TLS for an encrypted session token, and stores only the
  token. Keep the answer factual and volunteer it in Review Notes rather than
  waiting for the question.
- **Guideline 2.4.1, iPad.** The project declares
  `TARGETED_DEVICE_FAMILY = "1,2"` with no size-class adaptation, so the app is
  reviewable on iPad while presenting an iPhone layout. Either be ready to
  justify it, or narrow the device family in a later submission — narrowing is a
  project change and must not be made mid-review.

## Sequencing against the release process

The backend remediation follows the canonical exact-artifact path in
`docs/release/README.md`: reviewed protected-main SHA, governed checkpoint,
staging, explicit owner authorization, and a passing production transaction.
The backend checkpoint manifest remains backend-only; adding iOS evidence to it
would create a circular dependency and is prohibited.

For a shared backend/iOS release, run the protected-main iOS compatibility
suite against the exact backend bundle first and retain its signed contract
attestation. Promote that exact backend artifact and require the production
transaction to complete successfully. Only then may Xcode Cloud create the
distribution build and signed distribution attestation. Run
the owner-dispatched `.github/workflows/shared-ios-release-gate.yml` workflow
with both attestations, the exact checkpoint run identity, production journal,
backend SHA, iOS SHA, and source build number. The workflow resolves and
validates the exact bundle and checkpoint manifest by immutable artifact ID,
requires the distribution attestation to postdate backend production
completion, and uploads `nexus.shared-ios-release-gate.v1` from the
`production-release` environment.

Do not assign a TestFlight group, submit the build for App Review, or release it
to users without the successful workflow run and its passing receipt artifact;
a locally generated receipt is not release authorization. Once submitted, hold
the bound backend runtime and contract frozen until Apple posts a decision.
