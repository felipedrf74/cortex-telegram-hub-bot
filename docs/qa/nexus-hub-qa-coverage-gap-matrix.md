# Nexus Hub — QA Coverage Gap Matrix

**Generated:** 2026-04-30
**Audit:** second-round QA gap review at HEAD `414383b` (4.14.106 deployed)

Evidence levels (recap):
- **E0** — no evidence found
- **E1** — documentation-only claim
- **E2** — code inspection only (no runtime test)
- **E3** — unit/integration test evidence; test exercises the bug path adversarially
- **E4** — local full-product smoke
- **E5** — staging smoke
- **E6** — iOS simulator
- **E7** — production-safe validation

## Evidence-level by area

| Area | Round-1 evidence | Round-2 evidence | Missing tests | Missing smoke | Missing iOS | Confidence |
|---|---|---|---|---|---|---|
| Chat security: tenant scoping | E2 (code review) | **E3** (`__tests__/scope/content-tenant-isolation.test.ts` + 4 other tenant scope files) | tenant-switch live invalidation hook | `chat-tenant-security-smoke.js` not run | iOS scope-key invalidation only test-covered, not E6 | MEDIUM-HIGH |
| Chat security: tool authorization | E2 | **E3** (`tool-executor-allowlist.test.ts`, `chat-tool-auth-fail-closed.test.ts`) | per-object confirmation; double-confirmation; sticky `confirmedDestructiveAction` | not exercised | n/a | MEDIUM |
| Chat security: prompt injection | E2 | **E3** (Gemini + OpenAI provider tests) | Anthropic + Anthropic-streaming variants; injection-string parameter table; opaque delimiter nonce unpredictability | not exercised | n/a | MEDIUM |
| Chat security: streaming/retry | E2 (code review only) | **E2** (no test added) | content-hash-based dedup on stream resume; cross-uuid dedup | not exercised | n/a | LOW |
| Live model routing: classify path | E3 (existing tests) | E3 | PII scrubber cross-pattern coverage | not exercised | n/a | MEDIUM |
| Live model routing: chat/toolUse path | E3 | **E3** | mid-tool-loop fallback orphan `tool_use_id`; provider-A 2 turns + provider-B turn 3 | provider-failure simulation in staging | n/a | MEDIUM-LOW |
| Live model routing: tool-continuation path | E2 | E3 (filteredTools fail-closed in both providers) | none specific | not exercised | n/a | MEDIUM-HIGH |
| Live model routing: vision path | E2 | E2 | image-byte log redaction; provider SDK debug-log enforcement | not exercised | n/a | LOW |
| Live model routing: internal AI proxy | E2 | **E3** (`internal-routes-runtime.test.ts` 25 tests) | real `isLoopbackRequest` test (not mocked) — `X-Forwarded-For` trust path | not exercised | n/a | MEDIUM |
| Live model routing: per-domain operator pins | E2 | **E3** (Gemini + OpenAI tier-supplied path tests) | `setActiveModel` race / live config mutation | not exercised | n/a | MEDIUM |
| Live model routing: kill-switch | E2 | E2 (assertion exists in `trackedCreate`) | startup state log; `AI_CHAT_PRIMARY=anthropic` + `ANTHROPIC_ENABLED=false` Sentry warning | not exercised | n/a | MEDIUM |
| Secretary scheduling: agenda lifecycle | E1 (docs) | **E3** (synced/failed_sync/completed each have a dedicated test) | conflict resolution + reflow with external constraint; sticky stale `start_at`/`end_at` on superseded rows | not exercised | iOS rendering tested at unit level | MEDIUM-HIGH |
| Secretary scheduling: agenda ownership | E1 | E3 (decision_explanation persisted + read-back tested) | iOS read-back asserts `decision_explanation` non-null | n/a | n/a | MEDIUM |
| Secretary scheduling: cancellation cascade | E2 | **E0** (no test for cross-skill cascade) | training cancel → secretary agenda canceled; secretary cancel → cooking signal stale | not exercised | n/a | **LOW (P0 gap)** |
| Secretary scheduling: reminders | E2 | **E3** (`agenda_item_id` FK + uniqueness test) | reminder-cancel-on-agenda-cancel | not exercised | n/a | MEDIUM-HIGH |
| Secretary scheduling: reflow/compression | E2 | E3 | external-calendar-changed reflow | staging test missing | n/a | MEDIUM |
| Training: plan lifecycle | E3 | **E3** (`runPrePersistCancellationSaga` 12 it() cases) | concurrent cancel real race (multi-process); plan-version increment from regenerate-without-cancel | not exercised | n/a | MEDIUM |
| Training: calendar sync | E2 | **E3 (partial)** (`recordCalendarOwnership` dedup tested) | adapter-without-`findEventsByAgendaItemId` retry-after-network-blip duplicate | training-calendar-staging-smoke.sh blocked | n/a | MEDIUM-LOW |
| Training: rich iOS payload | E1 | **E2 (iOS-side)** + **E3 (backend-side)** | iOS `WeekSession.decisionExplanation` decode test | not exercised | iOS contract test missing | MEDIUM-LOW |
| Training: feedback loop | E2 | E2 | feedback submission + UI/contract match | not exercised | iOS feedback test | LOW |
| Content: tenant scoping | E1 | **E3 (partial)** (3 tests cover ~11 sites) | per-site adversarial proof for content_performance, content_scripts, learned_patterns separately | not exercised | n/a | MEDIUM-LOW |
| Content: provenance / references | E1 | E3 (provenance ledger added) | `claims=[]+refs>0` boundary test; `generateScript` refusal when zero usable refs; `needsReview` reference partition | not exercised | iOS provenance rendering | LOW |
| Content: voice profile | E1 | E2 | tenant-A voice into tenant-B output | not exercised | n/a | LOW |
| Content: editorial workflow | E2 | **E3** (illegal transition rejected) | actor-permission check assertion (currently owner-only via `tenant_id=user_id`) | not exercised | n/a | MEDIUM |
| Content: radar / dedup / novelty | E2 | E3 (dedup AsyncLocalStorage fail-closed tested) | duplicate-idea detection adversarial | not exercised | n/a | MEDIUM |
| Content: approval gates | E1 | **E3** (`approvalConfirmed: true` from non-owner now rejected) | role-based approver test | not exercised | n/a | MEDIUM |
| Content: portal management | E2 | E2 | portal admin chat-diagnostics rate limit; bulk admin actions | not exercised | n/a | LOW |
| Content: iOS rendering | E1 | E2 (iOS code review) | `content_output_provenance` decode + render | not exercised | iOS-GAP-2 | LOW |
| Cross-skill: shared context | E1 | **E0** (no end-to-end test) | training cancel → cross-skill stale; cooking meal-prep using cancelled-plan signal | not exercised | n/a | **LOW (P0 gap)** |
| Cross-skill: secretary arbitration | E1 | E3 (Training + Cooking ordering tested) | Finance ordering test missing; legacy training-plan-calendar-sync route still bypasses | not exercised | n/a | MEDIUM-LOW |
| Cross-skill: signal isolation | E1 | **E2** (user-id isolation tested, NOT tenant-id) | tenant A signal not visible to tenant B | not exercised | n/a | LOW |
| Cross-skill: warning dedup | E0 | E0 | aggregator at chat surface | not exercised | n/a | LOW |
| Skill versioning: registry | E2 | E3 (illegal transition rejected) | full transition matrix table-driven | not exercised | n/a | MEDIUM |
| Skill versioning: rollouts | E2 | E2 | dual-active rollout determinism; rollout uniqueness | not exercised | n/a | LOW |
| Skill versioning: rollback | E2 | E2 | atomic `rollbackToVersion(skillId, version)` helper | not exercised | n/a | LOW |
| Skill versioning: memory schema compat | E2 | E3 (activation refused on incompatible schema) | auto-stale on activation; auto-migration option | not exercised | n/a | MEDIUM |
| Cross-skill memory: scoping | E2 | E3 (tenant-shared cross-tenant denied) | `tenant_id=user_id` write/read asymmetry; multi-user same-tenant read | not exercised | n/a | MEDIUM |
| Cross-skill memory: credential guard | E2 | **E3 (best-in-class)** (13 patterns table-driven) | none significant | not exercised | n/a | HIGH |
| Cross-skill memory: correction lineage | E2 | **E3** (full lineage preserved) | none significant | not exercised | n/a | HIGH |
| Cross-skill memory: stale handling | E2 | E2 | `expires_at` enforced on read (currently lazy via cleanup) | not exercised | n/a | LOW-MEDIUM |
| Cross-skill memory: version-aware | E2 | E3 (`markSkillMemoriesStaleForVersion` exists) | called from `activateSkillVersion` automatically; called from cancellation paths | not exercised | n/a | LOW |
| Calendar/agenda: provider sync states | E2 | E3 | external-deletion repair path (no production caller for read-back) | staging blocked | n/a | LOW-MEDIUM |
| Calendar/agenda: idempotency | E2 | E3 (training side dedup tested) | secretary `findEventsByAgendaItemId`-optional adapter fallback | not exercised | n/a | MEDIUM-LOW |
| Calendar/agenda: cleanup on cancel | E1 | **E0** (no cross-skill cleanup test) | training cancel → secretary agenda canceled (P0) | not exercised | n/a | **LOW (P0 gap)** |

## Summary

**Coverage by evidence level (after round 2):**
| Level | Count | % |
|---|---|---|
| E3 (unit-test adversarial) | ~30 areas | ~58% |
| E2 (code inspection) | ~14 areas | ~27% |
| E1 (docs only) | ~3 areas | ~6% |
| E0 (no evidence) | ~5 areas | ~10% |
| E4+ (smoke/staging/iOS) | **0 archived** | **0%** |

**The biggest categorical gap is E4–E6 evidence preservation.** No staging smoke logs are saved. No iOS `.xcresult` is archived. The Opus re-audit transcript was not preserved. This is documentation hygiene, not absent functionality, but it makes post-incident replay impossible.
