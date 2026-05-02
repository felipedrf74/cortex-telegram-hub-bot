# Training open items

## P0

- None reproduced in this pass.

## P1

- None remaining from the fixed scope after focused validation. Final full verify result is recorded in the final report.

## P2

| ID | Area | Item | Next action |
| --- | --- | --- | --- |
| TR-P2-DEVICE | iOS | Fixture-based physical-device Training interaction passed, but fresh-auth/TestFlight, Apple/Health/APNs, and account-switch stale-cache paths were not run. | Run true TestFlight/fresh-auth Training smoke on an available iPhone. |
| TR-P2-PROVIDER | Calendar | Google/Outlook provider lifecycle smoke not run in this pass. | Run non-production provider lifecycle smoke with provider read-back and cleanup. |
| TR-P2-MESH | Context | Some Training mesh/context readers should require tenantId as well as userId. | Refactor mesh readers to tenant-explicit APIs and add cross-tenant tests. |
| TR-P2-FEEDBACK | Adaptation | Feedback submission through iOS was not manually exercised. | Add iOS/local smoke for too easy, too hard, skipped, soreness, and substitution feedback. |
| TR-P2-CYCLING | Engine | Cycling-specific progression remains shallower than running/strength. | Add cycling/hybrid eval scenarios and catalog progression tests. |

## P3

- Add richer local Training seed so local smoke can generate a personalized plan instead of stopping at the profile-completion gate.
- Add visual fixture snapshots for partial/failed/superseded sync states.
