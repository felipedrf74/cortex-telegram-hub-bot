# Risk-Based Release Gate Matrix

Status: canonical
Owner: release lead (Felipe)
Last verified: 2026-06-16
Update policy: update when changed-area gating rules change. The runtime classifier at `scripts/changed-area-classifier.sh` implements this matrix.

Date: 2026-06-16

| Changed area | Required checks | Optional/conditional checks | Production gates | Can skip safely when | Cannot skip when |
| --- | --- | --- | --- | --- | --- |
| Docs only | `git diff --check`, doc link/path sanity, release identity refresh | Markdown lint if available | None unless docs are the approval artifact | No source/test/package/migration/deploy files changed | Release notes/checklists are the artifact being approved |
| Backend service/API | `npx tsc --noEmit`, focused Vitest for touched services/routes | `npm run verify` before merge/RC | Staging smoke if app-facing behavior changed | Only internal docs/comments changed | Auth, tenant, persistence, model, calendar, provider, or app-facing contract changed |
| Cooking backend | Cooking focused tests, tenant forged request test, fixture provider gate | Portal smoke if portal path changed, iOS decoder tests if contract changed | Focused Cooking staging smoke | No Cooking/API/portal/schema changes | Pantry/preferences/recipes/substitutions/tenant routes changed |
| Training iOS | Focused Training unit tests, UI tests with single simulator UDID | Full iOS suite on RC | Signed TestFlight/device only for native/auth/provider release gates | No iOS or Training API contract changes | Calendar state, plan rendering, auth, HealthKit, APNs, account switching changed |
| Calendar/agenda | Lifecycle tests, no-duplicate/idempotency tests, cancellation cleanup tests, Secretary agenda provider sync tests when touched | Google/Outlook staging provider smoke; no-write fixture fallback only when live credentials are unavailable | Provider smoke and cleanup evidence | No calendar/provider/agenda/migration changes since last smoke | Provider mapping, cancellation, sync, reminders, Secretary arbitration changed |
| Decision Center/notifications | Decision Center service/API tests, notification dedupe/count tests, action truth-table checks | iOS decision decoder/UI interaction pass; APNs mock/staging smoke when delivery changed | Staging Decision Center/notification smoke and safe production monitoring | Copy/docs-only changes | Decision visibility, notification delivery, APNs routing, action execution, or native decision surfaces changed |
| Tenant/security/auth | Tenant isolation tests, auth-bypass/forged-tenant tests, audit/logging tests | Staging tenant smoke | Production monitoring for denial/audit spikes | Pure UI copy/docs changed | Any backend authorization, memory, prompt, retrieval, admin, support path changed |
| Model routing/provider fallback | Routing tests for classify/chat/toolUse/tool-continuation, fallback simulation, filtered tools | Bounded real-provider smoke by approval | Provider metadata/logging checks | No routing/provider/env/operator override changes | Provider registry, domain pins, tool filters, fixture mode, fallback changed |
| Portal UI | Portal route tests, browser interaction smoke | Staging portal smoke for release candidate | Portal smoke on staging if user/admin-facing | No portal files/routes changed | Admin/tenant/scoped portal data paths changed |
| iOS non-native UI | Focused presentation/decoder/view-model tests, simulator interaction for changed surfaces | Full iOS suite on RC | TestFlight if release build/native capabilities are involved | Backend-only change with stable contract | SwiftUI navigation, cache, buttons, state rendering, decoders changed |
| Migrations/data shape | Migration ordering/syntax, migration rehearsal if possible, affected service tests | Staging DB snapshot before migration | Production predeploy DB snapshot and rollback caveats | No migrations/data/backfill changes | Any irreversible or tenant/user data-shape migration exists |

## Gate Rule

A skipped check must be recorded as `skipped_by_risk_matrix`, with the changed-file reason. A skipped high-risk check must have owner-accepted rationale.
