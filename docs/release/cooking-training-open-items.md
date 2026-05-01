# Cooking + Training Open Items

Date: 2026-05-01

## Inventory

| ID | Workstream | Severity | Type | Source | Evidence | Main blocker | Production blocker | Recommended action | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| CT-P0-001 | Cooking | P0 | tenant/security | Current re-validation | E3/E4/E5 | No | No | None. No known P0 after forged tenant, body spoof, tool tenant, portal stale-data, and provider fixture tests. | Closed |
| CT-P1-001 | Cooking | P1 | build/test | Current re-validation | E3/E4 | No | No | None. Typecheck, focused tests, and full verify evidence pass. | Closed |
| CT-P2-001 | Cooking | P2 | product quality | `docs/cooking/cooking-open-items.md` | E1/E2 | No | No | Add in-place substitution acceptance/replacement workflow if product wants direct apply actions. | Open |
| CT-P2-002 | Cooking | P2 | portal/frontend | `docs/cooking/cooking-production-open-blockers.md` | E1/E2 | No | No | Add recipe library, meal-plan, and grocery-settings portal deep editors once backend contracts are promoted. | Open |
| CT-P2-003 | Cooking | P2 | portal/security smoke | `docs/qa/cooking-codex-revalidation-fixes.md` | E2/E5 partial | No | Conditional | Add non-loopback forged operator/session browser probe in staging or a hardened local portal mode. | Open |
| CT-P2-004 | Cooking | P2 | iOS/frontend | `docs/cooking/cooking-open-items.md` | E2 | No | No | Add stronger allergy/restriction visual treatment and unknown/future Cooking enum fallback tests. | Open |
| CT-P2-005 | Cooking | P2 | product quality | `docs/cooking/cooking-open-items.md` | E1 | No | No | Expand pantry quantity normalization, low-stock suggestions, price/budget optimizer, leftovers/waste, and store unavailable-item fallback. | Open |
| TR-P0-001 | Training | P0 | iOS/frontend | `/tmp/ios-audit-2026-04-30.md`, superseded | E2/E5 current | No | No | Old F1-F5 iOS blockers are closed or constrained by `c83ee42` and May 1 focused validation. | Closed |
| TR-P1-001 | Training | P1 | provider/calendar lifecycle | `docs/ios/training-rich-payload-smoke.md`, `docs/training/final-production-go-no-go.md` | E5/E6 historical | No | Conditional | If the exact Training RC changed since provider smokes, rerun non-production Google/Outlook calendar create/read/update/cancel proof. | Open condition |
| TR-P1-002 | Training | P1 | iOS/device | `docs/ios/training-rich-payload-smoke.md` | E5 local only | No | Conditional | Run signed TestFlight/device smoke for fresh auth/onboarding, Apple Sign In, HealthKit/Apple Watch recognition, APNs token upload, and true account switching. | Open condition |
| TR-P1-003 | Training | P1 | deployment process | `docs/training/final-production-go-no-go.md` | E6 historical | No | Yes before deploy | Take production-predeploy DB snapshot immediately before deployment when backend release/migrations are in scope. | Open condition |
| TR-P2-001 | Training | P2 | product claim | `docs/training/production-open-blockers.md` | E2/E3 | No | No | Prove rich iOS feedback persistence changes future plans before making adaptive-learning claims. | Open |
| TR-P2-002 | Training | P2 | visual regression | `docs/ios/training-rich-payload-smoke.md` | E2/E5 | No | No | Add broader screenshot automation for synthetic lifecycle states and dense weeks. | Open |
| SH-P2-001 | Shared | P2 | test gap | Prior Cooking iOS re-validation | E2 | No | No | Triage unrelated full iOS suite Content localization/model failures before broad iOS release claims. | Open outside Cooking/Training |

## Priority Order

1. No P0/P1 code fix is currently selected.
2. Before any production deployment, close operational conditions `TR-P1-001`, `TR-P1-002`, and `TR-P1-003` as applicable to the exact candidate.
3. For product polish after merge, prioritize `CT-P2-001` and `CT-P2-002`.
4. For stronger release evidence, prioritize `CT-P2-003` and `TR-P2-002`.

