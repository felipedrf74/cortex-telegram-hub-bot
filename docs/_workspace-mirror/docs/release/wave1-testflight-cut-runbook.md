# Wave 1 TestFlight Cut Runbook

Status: operator-ready
Owner: Felipe
Last verified: 2026-05-10

Use this runbook after iOS `main` is at the Wave 1 version-bumped commit and the Release-mode validation note is green.

## Pre-Cut Verification

- Confirm iOS `main` is checked out and at the version-bumped commit `5981d10`.
- Confirm Xcode is using Felipe's Apple Developer account and the expected signing identity.
- Confirm the app scheme is using Release configuration for Archive.
- Confirm the provisioning profile is current and is an App Store distribution profile.
- Confirm bundle ID is `me.nexushub.app`.
- Confirm the selected destination is `Any iOS Device (arm64)`, not a simulator.
- Confirm the displayed app version/build is `1.4.2 (16)`.
- Confirm backend production health is green at `4.14.147` or later before inviting testers.

## Archive Step

1. Open `/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub/Nexus Hub.xcodeproj`.
2. Select scheme `Nexus Hub`.
3. Select destination `Any iOS Device (arm64)`.
4. In Xcode, choose `Product` -> `Archive`.
5. Wait for Organizer to open with the new archive.
6. Verify Organizer shows version `1.4.2` and build `16`.

## Distribute App Step

1. In Organizer, select the new archive.
2. Click `Distribute App`.
3. Choose `App Store Connect`.
4. Choose `Upload`.
5. Use automatic signing.
6. Keep default validation/upload options unless Xcode flags a specific signing or entitlement issue.
7. Start upload and wait for completion.

## Post-Upload Verification

1. Open App Store Connect.
2. Navigate to the app -> `TestFlight`.
3. Verify build `1.4.2 (16)` appears.
4. Wait for processing to finish.
5. If processing fails, capture Apple's processing error before attempting another archive.

## TestFlight Invitation Flow

- Internal testers can receive the build as soon as processing completes.
- External testers may require App Review beta approval and Apple's Terms of Service approval window.
- Keep the application form gate enabled for external cohorts so Wave 1 remains controlled.
- If external review blocks, invite internal testers only and hold Wave 1 external sends until the review clears.

## Wave 1 Cohort Invitation

- Use the approved Wave 1 invite list only.
- Send in batches small enough that Felipe can watch onboarding, APNs, and provider-state logs after each wave.
- Record invite batch time, accepted count, and any blocked onboarding cases in the release notes or cohort tracker.
- Expect tester acceptance to arrive over hours, not minutes.

## Rollback Path

- If a Wave 1 tester reports a P0 issue, expire the affected TestFlight build in App Store Connect.
- Pause additional invitations immediately.
- Send a short operator note to invitees acknowledging the pause and asking them not to continue testing the affected build.
- Cut a hotfix branch from iOS `main`, apply the fix, rerun Release build + Release visual matrix where relevant, bump build number, and upload a replacement TestFlight build.
- Do not reuse build `16`; App Store Connect requires monotonically increasing build numbers.

## Operator-Physical Smoke Checklist

- Fresh install on a physical device.
- Sign in through at least one production auth path: Apple ID, Google, or email.
- APNs token upload and delivery test using the existing alert drill or a safe test notification.
- Two-account switch test: Felipe -> Jaqueline -> Felipe. Confirm Garmin/readiness values do not leak between accounts.
- Real Gmail/Outlook/Health provider-state check.
- Interrupted onboarding flow: start onboarding, leave the app, resume, and verify state recovery.
- Garmin MFA + live session if Felipe has the real Garmin account ready.

## Production Watcher First 48 Hours

- Check `error_log` and `operator_alerts` daily for Garmin tenant-isolation watcher matches.
- Expected result on every run: `matchedCount: 0`, no open `garmin_tenant_isolation_watcher` alert.
- Quick local/staging check:

```bash
cd /Users/felipedominguez/Desktop/Nexus\ Hub/engine
ssh dominguez@serverdominguez "cd /home/dominguez/telegram-hub-bot-staging && node scripts/check-garmin-watcher-state.mjs"
```

- Staging evidence for the watcher-state script should show `recentErrorLogCount: 0` and `openAlertCount: 0` after synthetic probes are cleaned.
- If the production watcher ever reports a match, pause invitations and investigate before continuing Wave 1.
