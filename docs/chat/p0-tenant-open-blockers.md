# P0 Chat Tenant Open Blockers

Generated: 2026-04-29 12:12 WEST

Branch: `feature/chat-p0-tenant-security-audit`

## Release Verdict

Current verdict for the focused P0/P1 tenant-safety patch: GO WITH CONDITIONS for staging validation.

Current verdict for a broad Chat product release: NO-GO until the remaining P1/P2 gates below are closed or explicitly accepted.

The immediate P0 callback replay and global task-provider issues are closed in code and covered by focused tests. The remaining production conditions are mostly rollout validation and broader Chat capability gaps, not known active tenant-leak exploits in the current canonical iOS Chat model.

## Closed In This Batch

| ID | Prior severity | Area | Status | Closure evidence |
| --- | --- | --- | --- | --- |
| CHAT-P0-01 | P0 | Inline callbacks | Closed | Scoped callback migration/API; scoped refs reject cross-tenant/user lookup; legacy scoped refs not exposed through global lookup; replay consume controls added. |
| CHAT-P0-02 | P0 | Task callbacks | Closed | Callback task actions use `getTaskProviderForUser(userId)` instead of global `microsoftTodo`. |
| CHAT-P0-03 | P0 if enabled | WebSocket | Mitigated | WebSocket remains disabled by default and now has JWT/device validation plus tenant propagation if enabled. Full WebSocket release remains blocked until lifecycle/idempotency tests exist. |
| CHAT-P1-04 | P1 | Attachments | Closed | Attachment classifier passes `tenantId` through provider routing/fallback metadata. |
| CHAT-P1-05 | P1 | Portal/support | Closed for metadata-only diagnostics | User diagnostics are tenant filtered; diagnostic reads are audited. |
| CHAT-P1-06 | P1 | Callback tests | Closed | Added focused scoped callback, replay, legacy quarantine, route, and provider ownership tests. |
| CHAT-P2-01 | P2 | Provider fallback | Closed | Direct fallback receives `{ userId, tenantId }` options. |

## Remaining Open Items

| ID | Severity | Area | Blocker | Why it matters | Required closure |
| --- | --- | --- | --- | --- | --- |
| CHAT-P1-01 | P1 must fix before true workspace release | Active tenant | Active tenant membership is not modeled; current Chat tenant is canonicalized to the authenticated user ID. | True workspace switching cannot be safely claimed. | Add tenant/workspace membership, active tenant selection, role checks, tenant-aware source reads, and same-user/different-tenant tests. |
| CHAT-P1-02 | P1 must fix before true workspace release | Daily context | Daily context cache is tenant-scoped, but several source reads are still user-only. | Same user across multiple future workspaces could get mixed task/calendar/training/content prompt context. | Make source reads tenant-aware or explicitly system/public scoped, then test same-user/different-tenant isolation. |
| CHAT-P1-03 | P1 must fix before broad tenant content release | Global content context | Some content context paths include `user_id IN (0, ?)`. | Global rows can become prompt context for any user if they contain tenant-private content. | Define public/system content scope, quarantine ambiguous global rows, and avoid using `user_id=0` as private prompt context. |
| CHAT-P1-07 | P1 release gate | Staging validation | Migration `086` and scoped Chat callbacks have not been deployed to staging or smoke-tested there. | The patch must prove migration compatibility and callback behavior against a staging DB/runtime. | Take staging snapshot, deploy to staging, run focused Chat tenant smoke, verify callback actions, and confirm cleanup. |
| CHAT-P1-08 | P1 release gate | Full local smoke | **Closed for focused tenant-isolation scope.** Full local backend, authenticated 13-route API smoke, focused Chat tenant smoke, provider/context/tool tests, and iOS cache tests passed on 2026-04-29. | This proves the focused P0/P1 tenant-security patch locally, but not the entire broad Chat product release. | Keep broad Chat day-to-day/provider/streaming smoke gates separate. |
| CHAT-P2-02 | P2 should fix | Logs/observability | Some chat logs/telemetry still omit tenant/user metadata. | Makes tenant incidents harder to investigate. | Standardize tenant-safe chat log fields without raw message/prompt/context. |
| CHAT-P2-03 | P2 should fix before WebSocket release | iOS/WebSocket streaming cache | Dormant streaming UX still lacks full scoped lifecycle/idempotency validation. | Unsafe if streaming is re-enabled without durable state and cache partition proof. | Keep WebSocket disabled or complete scoped streaming lifecycle, reconnect, retry, and cache tests. |
| CHAT-P2-04 | P2 should fix before broad destructive actions | Durable tool lifecycle | No durable chat-specific tool-call lifecycle table was added in this batch. | Tool retries and duplicate prevention rely on route/tool behavior rather than a durable action ledger. | Add scoped tool-call/skill-invocation ledger before broad destructive Chat actions. |
| CHAT-P2-05 | P2 release gate | iOS cache smoke | **Closed for tenant-switch cache scope.** `ChatRepositoryTests` passed on iPhone 17 Pro simulator and covers scope-key replacement/stale cache prevention. | Runtime app rendering against local backend remains a broader iOS smoke concern, but the tenant-cache acceptance point is covered. | Keep broad iOS Chat local smoke separate from this focused tenant gate. |
| CHAT-P3-01 | P3 deferrable | Prompt minimization | Prompt metadata includes numeric tenant/user IDs in some paths. | Low direct risk, but can be minimized. | Replace raw IDs in prompt text with opaque labels where model reasoning does not need IDs. |

## Deployment Conditions For Focused Patch

Before production promotion:

1. Take fresh production DB snapshot.
2. Rehearse migration `086` against a staging/predeploy clone.
3. Deploy the patch to staging.
4. Run focused staging Chat tenant smoke:
   - scoped callback create/use/replay-deny
   - task callback uses authenticated user's provider
   - tenant mismatch returns `403`
   - attachment classifier route remains healthy
   - portal diagnostics audit entries are written
5. Review `docs/local/chat-tenant-security-smoke-results.md` for the focused local tenant smoke.
6. Keep broad iOS runtime Chat smoke separate from the focused tenant-cache XCTest proof.
7. Confirm `IOS_WS_ENABLED=false` in staging and production unless WebSocket lifecycle hardening has completed.
8. Confirm no release copy claims true workspace tenant switching.

## Do Not Claim Yet

- True tenant/workspace switching.
- WebSocket Chat streaming.
- Tenant-aware vector retrieval.
- Raw support/admin chat review.
- Durable attachment/file lifecycle beyond authenticated current route behavior.
- Durable tool-call action ledger.
- Full Chat quality/day-to-day release readiness from this patch alone.

## Release Recommendation

Recommended next step: merge/deploy only to staging after review, run focused Chat tenant smoke, then decide whether this security patch can be promoted independently from the larger Chat product upgrade.

Do not promote as a broad Chat release until the remaining P1 release gates and explicit product-readiness checks are closed.
