# QA Remediation Progress

Date: 2026-04-29

## 2026-04-30 Second-Round QA Remediation

Branch / backup:

- Backend fix branch: `feature/r2-qa-remediation-training-secretary-cascade`
- Backend backup branch: `backup/r2-qa-remediation-before-fixes-20260430-0629`
- Backend backup tag: `backup-r2-qa-remediation-before-fixes-20260430-0629`
- iOS fix branch: `feature/ios-r2-contract-fixes`
- iOS backup branch: `backup/ios-r2-contract-fixes-before-20260430-0640`
- iOS backup tag: `backup-ios-r2-contract-fixes-before-20260430-0640`

Findings closed in code:

- `R2-P0-1` / `ADV-4`: Training cancellation now cascades to matching Secretary agenda items through `cancelTrainingPlanCrossSkillDependents()`.
- `R2-P0-2` / `ADV-5`: Training cancellation emits `training_plan_canceled` on the intelligence bus and marks downstream Cooking, Secretary, and Chat skill memories stale for the canceled training plan version.
- `R2-P0-3` / `FC-1`: The legacy training calendar sync path now submits a Secretary scheduling intent before creating provider calendar events, and it leaves sessions unscheduled when Secretary cannot return a valid slot.
- `R2-P1-3`: Empty-claims-with-references provenance now returns `no_claims` without forcing review.
- `R2-P1-4`: Source-required script generation now refuses generation when no usable authorized references exist.
- `R2-P1-5`: Content reference prompt context now partitions grounded references from inspiration-only references that must not be cited.
- `R2-P1-9`: `tenant_shared` skill-memory writes fail closed unless the temporary `ENABLE_TENANT_SHARED_MEMORY=true` gate is enabled or the owner bootstrap path is used.
- `R2-P1-14`: iOS `WeekSession` now decodes and renders `decision_explanation` / `decisionExplanation`.
- `R2-P1-15`: iOS `ContentIdea` now decodes `content_output_provenance`, unsupported claims, grounding status, and provenance references, and the idea review detail view renders backend-provided provenance warnings.

Validation completed:

- PASS: `npx tsc --noEmit`
- PASS: `npx vitest run __tests__/api/training-plan-calendar-sync.test.ts __tests__/api/training-plan-cancellation.test.ts __tests__/services/training-plan-cancellation-cascade.test.ts __tests__/services/skill-memory.test.ts __tests__/services/content-workflow-user-scope.test.ts __tests__/services/content-reference-provenance.test.ts`
  - 6 files / 73 tests
- PASS: `npm run verify`
  - 424 files / 6,364 tests
- PASS: `xcodebuild test -project "Nexus Hub.xcodeproj" -scheme "Nexus Hub" -sdk iphonesimulator -destination "platform=iOS Simulator,name=iPhone 17 Pro" -only-testing:"Nexus HubTests/ModelDecodingTests" -only-testing:"Nexus HubTests/TrainingPresentationTests" -only-testing:"Nexus HubTests/ContentIdeaReviewDetailRenderingTests"`
  - Result bundle: `/Users/felipedominguez/Library/Developer/Xcode/DerivedData/Nexus_Hub-gsoqdyrpqmkkotdmfddhuhobycvu/Logs/Test/Test-Nexus Hub-2026.04.30_06-47-47-+0100.xcresult`
- PASS: full iOS simulator test
  - Command: `xcodebuild test -project "Nexus Hub.xcodeproj" -scheme "Nexus Hub" -sdk iphonesimulator -destination "platform=iOS Simulator,name=iPhone 17 Pro"`
  - Result: 940 passed / 0 failed / 0 skipped
  - Result bundle: `/Users/felipedominguez/Library/Developer/Xcode/DerivedData/Nexus_Hub-gsoqdyrpqmkkotdmfddhuhobycvu/Logs/Test/Test-Nexus Hub-2026.04.30_07-00-39-+0100.xcresult`
  - Archived evidence: `docs/release/smoke-evidence/ios-full-test-20260430-070039-summary.json`
  - Archived bundle: `docs/release/smoke-evidence/ios-full-test-20260430-070039.xcresult.zip`

Known remaining follow-ups before claiming full second-round PASS:

- `R2-P1-1`: Mid-tool-loop provider fallback should fail typed instead of orphaning `tool_use_id`.
- `R2-P1-2`: Destructive chat confirmation should bind to a specific tool/object target, not a turn-wide boolean.
- `R2-P1-6`: Silent push/cache invalidation remains a backend+iOS follow-up.
- `R2-P1-7`: Secretary provider adapters should require or emulate `findEventsByAgendaItemId` for duplicate prevention.
- `R2-P1-10` / `R2-P1-12`: Staging smoke and Opus re-audit artifacts still need to be archived under `docs/release/smoke-evidence/` before the QA-of-QA evidence gap is fully closed. `R2-P1-11` now has archived full iOS `.xcresult` evidence.

Release-gate note:

- This branch closes the active second-round P0s in focused code/tests.
- Production promotion still requires a fresh production backup/snapshot and production health capture.

Git and staging rollout status:

- Backend feature branch pushed: `feature/r2-qa-remediation-training-secretary-cascade` at `729f376`.
- Backend `main` pushed: `729f376`.
- iOS feature branch pushed: `feature/ios-r2-contract-fixes` at `65924fe`.
- iOS `main` pushed: `65924fe`.
- PASS: staging deploy from backend `main`
  - Command: `./scripts/deploy-staging.sh`
  - Evidence: `docs/release/smoke-evidence/staging-deploy-20260430-r2-remediation.log`
  - Result: staging content engine OK, staging portal OK, production untouched.
- PASS: general staging smoke
  - Command: `./scripts/staging-smoke.sh`
  - Evidence: `docs/release/smoke-evidence/staging-smoke-20260430-r2-remediation.log`
  - Result: 17/17 tests passed; DB `integrity_check=ok`; staging safe to promote per script.
- PASS WITH CONDITIONS: focused staging Chat tenant/security smoke
  - Command: remote staging run of `node scripts/chat-tenant-security-smoke.js --base-url http://127.0.0.1:8201`
  - Evidence: `docs/release/smoke-evidence/staging-chat-tenant-security-smoke-20260430-r2-remediation-rerun.log`
  - Result: 14 pass / 2 partial / 0 fail.
  - Partials: admin/support diagnostics token was not supplied; real provider fallback call was not made. No cross-tenant leakage or prompt-injection leak was observed.
- PASS: production promotion
  - Command: `./scripts/promote-to-prod.sh`
  - Evidence: `docs/release/smoke-evidence/prod-promote-20260430-r2-remediation-confirmed-yes-stream.log`
  - Result: production promoted from `4.14.106` to `4.14.107` at commit `f78eb61`.
  - Backup: `deploy.sh` created a predeploy server backup including `bot.db` before syncing the new artifact.
- PASS: production health
  - Evidence: `docs/release/smoke-evidence/prod-health-20260430-r2-remediation-corrected.log`
  - Result: content engine local health OK; Nexus Hub local snapshot returned `4.14.107`; `nexus-hub` and `content-engine` PM2 processes online with zero unstable restarts after deploy.

## Branch / Backup Setup

- Starting branch: `feature/content-editorial-mutation-contracts`
- Starting commit: `21a27ff8a7f350244105fe189de677367bbd665d`
- Backup branch: `backup/codex-qa-remediation-20260429-2314`
- Backup tag: `backup-codex-qa-remediation-20260429-2314`
- Dirty in-flight work preserved in stash: `codex qa remediation inflight content upgrade 20260429-2314`
- Remediation branch: `feature/qa-remediation-content-creation-upgrade`
- Remediation branch base: `main` at `34add9a`
- Replayed commits: `1dbaf6d`, `888b69e`, `a0341d5`, `e1591f6`, `21a27ff`
- In-flight content work applied on top of the remediation branch from the preserved stash.

## Block 1 — Internal AI Proxy Hardening

Findings targeted:

- `B-OPUS-P0-1`: Internal AI proxy reachable from any network
- `B-OPUS-P0-2`: Internal `ai-complete` accepts attacker-controlled `userId` / `tenantId`
- `E-P3-1` / Opus-corrected P2: Internal AI route scope attribution weakness
- Related scan fix: remove hardcoded Anthropic fallback model in `ai-complete` by resolving through `getEffectiveDomainModel('anthropic', 'content')`.

Changes:

- Added default loopback enforcement to `/api/v1/internal/*` with `INTERNAL_REQUIRE_LOOPBACK !== 'false'`.
- Kept the shared-secret check, but only after loopback enforcement.
- Stripped body-supplied `userId` and `tenantId` in `ai-complete`; calls are billed as system usage (`user_id=0`, `tenant_id=0`) until a server-side service-identity allowlist exists.
- Added warning metadata for stripped attribution without logging prompts.
- Routed the Anthropic fallback model through live model configuration instead of a hardcoded model string.

Tests:

- PASS: `npx vitest run __tests__/api/internal-routes.test.ts __tests__/api/internal-routes-runtime.test.ts`
  - 2 files / 25 tests
- PASS: `npx tsc --noEmit`

Commit:

- Pending. This block has not been committed yet because the remediation branch still contains a large applied in-flight worktree from the content upgrade. The focused Block 1 diff is validated and ready to stage with related tests/docs.

Known follow-ups:

- A future service-identity allowlist can restore scoped attribution safely.
- `performance-summary` is still owner-bootstrap based; Opus classified that as separate `E-OPUS-P1-2`.

## Block 3 — Tool Authorization + Provider Fallback

Findings targeted:

- `A-P0-1`: Tool execution can dispatch unregistered tool names
- `A-P0-2`: Missing chat tool authorization context defaults too permissive
- `A-OPUS-P0-1`: Provider fallback can receive the full tool catalog when routing omits `filteredTools`

Changes:

- Added an explicit `ALLOWED_TOOLS` registry and startup parity assertion for every `executeToolCall` switch case.
- Unknown tool names now return `TOOL_NOT_ALLOWED` before any authorization check or side effect.
- Changed chat tool authorization to fail closed with `AUTH_REQUIRED` when the AsyncLocalStorage authorization context is missing.
- Hardened Gemini and OpenAI routing-option paths so callers must pass an explicit `filteredTools` array; `[]` means no tools and an explicit catalog means those exact tools. Legacy direct provider calls without an options bag remain compatible.

Tests:

- PASS: `npx vitest run __tests__/services/chat-tool-auth-fail-closed.test.ts __tests__/services/tool-executor-allowlist.test.ts __tests__/services/gemini-provider.test.ts __tests__/services/openai-provider.test.ts`
  - 4 files / 79 tests
- PASS: `npx tsc --noEmit`

Commit:

- Pending. Block 3 is validated and ready to stage with Block 1 or as its own focused commit after the dirty in-flight worktree is separated.

Known follow-ups:

- Full-suite execution may require updating older tool-executor tests to provide an explicit chat authorization context for known tool calls.

## Block 2 — Content Tenant Scoping Sweep

Findings targeted:

- `E-P0-1`: Artifact-chain saved idea lookup scoped only by title
- `E-P0-2`: `getScriptByPipelineId` script read lacked tenant/user scope
- `E-P0-3`: Learned-pattern artifact-chain fallback reused `pipeline.user_id` / null tenant scope
- `E-P1-2`: Taste profile blending used legacy user-only/global patterns
- `E-OPUS-P0-1`: Pipeline read in artifact chain lacked scope
- `E-OPUS-P0-2`: Topic feedback read in artifact chain lacked scope
- `E-OPUS-P0-3`: Content performance read in artifact chain lacked scope
- `E-OPUS-P0-4`: Script read in artifact chain lacked scope
- `E-OPUS-P0-5`: `updateFeedback` / `markScriptGenerated` allowed cross-tenant writes when caller omitted user context
- `E-OPUS-P0-6`: Content dedup fell back to global saved-ideas prompt when request scope was missing
- `E-OPUS-P1-1`: Angle distribution fell back to global aggregation
- `E-OPUS-P1-5`: Editorial approval confirmation lacked an actor authorization check
- `E-OPUS-P1-6`: Radar-signal conversion could elevate visibility scope without approval

Changes:

- Required explicit `(userId, tenantId)` scope for `getScriptByPipelineId()` and `getArtifactChain()`.
- Scoped artifact-chain reads for pipeline, topic feedback, saved ideas, scripts, content performance, and learned patterns through `contentScopePredicate()` / `contentScopeParams()`.
- Removed unscoped feedback mutation branches in `updateFeedback()` and `markScriptGenerated()`.
- Required scoped `getTopicById()` and `buildTasteProfileBlock()` reads.
- Changed content dedup and angle distribution to fail closed when no authenticated user scope is available.
- Added owner-only approval enforcement for approval-confirmed editorial transitions until a tenant approver role table exists.
- Blocked radar-signal conversion visibility-scope elevation without an explicit approval workflow.

Tests:

- PASS: `npx vitest run __tests__/scope/content-tenant-isolation.test.ts __tests__/services/content-workflow-user-scope.test.ts __tests__/services/content-learning-store.test.ts __tests__/services/content-editorial-workflow.test.ts`
  - 4 files / 43 tests
- PASS: `npx tsc --noEmit`

Commit:

- Pending. Block 2 is validated but not yet committed because the branch still carries large in-flight content work that must be staged carefully.

Known follow-ups:

- Tenant approver roles are not modeled yet. Current approval-confirmed transitions are intentionally conservative: only the owner of the content object in the active tenant can confirm approval.
- Legacy content rows without tenant/user scope remain subject to the existing quarantine/backfill strategy; no broadened fallback was added.

## Block 4 — Prompt Injection + Memory Secrets

Findings targeted:

- `A-OPUS-P1-1`: User message can inject a fake `[Current State]` trusted context block
- `H-OPUS-P0-1`: `skill_specific_memory` catch-all bypasses typed memory boundaries
- `H-OPUS-P0-2`: `UNSAFE_MEMORY_PATTERNS` misses modern credential and token formats

Changes:

- Added `buildScopedStateContextPrefix()` and replaced provider `[Current State]` trusted-context markers with opaque per-request state delimiters.
- Applied the state-context delimiter fix to Anthropic, Gemini, OpenAI, and OpenAI streaming paths.
- Expanded skill-memory unsafe patterns to reject JWTs, AWS access keys/secrets/session tokens, Google API keys, Stripe live keys, GitHub PATs, Slack tokens, SQL/NoSQL connection strings, private keys, and Azure connection strings.
- Added recursive unsafe-fragment detection for JSON memory payloads and memory keys.
- Schema-validated `skill_specific_memory` as a JSON object and rejected non-JSON catch-all memory or secret-bearing JSON payloads.

Tests:

- PASS: `npx vitest run __tests__/services/gemini-provider.test.ts __tests__/services/openai-provider.test.ts __tests__/services/skill-memory.test.ts`
  - 3 files / 101 tests
- PASS: `npx tsc --noEmit`

Commit:

- Pending. Block 4 is validated and ready to stage after dirty worktree separation.

Known follow-ups:

- `skill_specific_memory` currently uses a permissive JSON-object base schema. Per-skill schemas should tighten allowed fields as each skill matures.

## Block 5 — Lifecycle State Machine + Cross-Skill Scheduling

Findings targeted:

- `C-OPUS-P0-1`: Provider sync never advances agenda lifecycle to `synced` / `failed_sync`
- `C-OPUS-P0-2`: No completed lifecycle path for elapsed agenda items
- `I-P1-2` / `I-OPUS-P1-1`: Reminder lifecycle is not linked to agenda lifecycle
- Cross-skill Secretary ownership routing is still in progress; see follow-ups.

Changes landed so far:

- Provider sync success now maps agenda lifecycle to `synced`.
- Provider create/update/readback/delete failures now map agenda lifecycle to `failed_sync`, while remaining retryable.
- Added `markCompletedSecretaryAgendaItems()` to flip ended scheduled/synced/reflowed/compressed items to `completed`.
- Kept completed provider history intact; completed agenda items are no longer treated as provider cleanup candidates.
- Added `reminders.agenda_item_id` migration and unique index for agenda-linked reminders.
- Added reminder helpers to cancel/update active reminders by `agenda_item_id`.
- Canceling or superseding a Secretary agenda item now cancels active reminders linked to the affected agenda item.
- Persisted `decision_explanation` on `secretary_agenda_items` for iOS/support read-back.
- Documented the lifecycle state machine in `docs/secretary/agenda-lifecycle-state-machine.md`.

Tests:

- PASS: `npx vitest run __tests__/services/secretary-scheduling-arbitrator.test.ts __tests__/services/secretary-agenda-provider-sync.test.ts`
  - 2 files / 22 tests
- PASS: `npx tsc --noEmit`

Commit:

- Pending.

Known follow-ups:

- Training plan persistence now submits a Secretary-owned scheduling intent before creating a provider calendar event.
- Cooking meal-prep calendar creation now submits a Secretary-owned meal-prep intent before creating the provider event.
- Finance has no production scheduling writer today; added a reusable Finance scheduling intent contract for bill reminders, budget reviews, subscription reviews, purchase decisions, and finance admin blocks.
- Training calendar-sync backfill still contains direct sync/update paths and needs a second narrow patch if the release claim becomes "all Training calendar sync surfaces are Secretary-owned." The current fix closes plan-generation persistence, not every legacy backfill route.

Additional validation:

- PASS: `npx vitest run __tests__/api/training-plan-persistence.test.ts __tests__/services/secretary-scheduling-arbitrator.test.ts`
  - 2 files / 17 tests
- PASS: `npx vitest run __tests__/services/finance-secretary-integration.test.ts __tests__/api/cooking-routes.test.ts __tests__/api/training-plan-persistence.test.ts`
  - 3 files / 23 tests
- PASS: `npx tsc --noEmit`

## Block 6 — Schema Retrofits + Cross-Skill Signals

Findings targeted:

- `I-P0-2`: `training_agenda_event_ownership` lacked tenant scope
- `F-OPUS-P0-1`: `agent_signals` lacked tenant scope
- `C-P0-1`: Secretary decision explanation needed durable read-back

Changes:

- Added `migrations/099_training_agenda_ownership_tenant_scope.sql`.
- Added `tenant_id` to Training agenda ownership records, backfilled current rows to `tenant_id=user_id`, and added tenant-aware indexes.
- Updated Training ownership inserts, reads, idempotency checks, orphan reconciliation, and deletion marking to include tenant scope.
- Added `migrations/100_agent_signals_tenant_scope.sql`.
- Added `tenant_id` to `agent_signals`; user-scoped signal rows backfill to `tenant_id=user_id`, while legacy null-scope rows remain platform/global only.
- Updated `writeSignal()`, `readSignals()`, and `readRankedSignals()` to support explicit tenant scope and to avoid returning platform-global rows to tenant-scoped readers.
- `decision_explanation` was already added in Block 5 via `migrations/098_secretary_decision_explanation.sql` and Secretary read-back updates.

Tests:

- PASS: `npx vitest run __tests__/services/training-plan-lifecycle.test.ts __tests__/services/training-agenda-reconciliation.test.ts __tests__/services/tenant-scope-observability.test.ts __tests__/services/skill-memory.test.ts __tests__/services/skill-version-registry.test.ts`
  - 5 files / 70 tests
- PASS: `npx tsc --noEmit`

Commit:

- Pending.

Known follow-ups:

- True tenant-membership joins are still not available in this repo. Current backfill and default scoping use `tenant_id=user_id` for the existing single-user workspace model.
- Background content mesh jobs that run without user/tenant context still write platform/global signals. Tenant-scoped product readers no longer ingest those rows, but future tenant-level mesh jobs should pass explicit `tenant_id`.

## Block 7 — Skill Version + Memory Invariants

Findings targeted:

- `G-OPUS-P0-1`: skill version status can regress through unsafe transitions
- `H-P0-1` / `H-P0-2`: tenant-shared memory reads were not membership-validated
- `D-OPUS-P0-1`: plan version lifecycle was not explicitly decided/documented

Changes:

- Added an allowed transition map to `setSkillVersionStatus()` / `activateSkillVersion()`.
- Rejected illegal status regressions such as `active -> draft`.
- Added activation-time memory schema compatibility checks against active `skill_memories` rows.
- Made tenant-shared skill memory fail closed unless the requester can be treated as the canonical tenant owner under the current `tenant_id=user_id` product model.
- Documented the Training plan-version decision in `docs/training/plan-version-lifecycle.md`: keep the version primitive, but do not claim regenerate-without-hard-delete as production-active.

Tests:

- PASS: `npx vitest run __tests__/services/training-plan-lifecycle.test.ts __tests__/services/training-agenda-reconciliation.test.ts __tests__/services/tenant-scope-observability.test.ts __tests__/services/skill-memory.test.ts __tests__/services/skill-version-registry.test.ts`
  - 5 files / 70 tests
- PASS: `npx tsc --noEmit`

Commit:

- Pending.

Known follow-ups:

- Add durable tenant membership / approver-role tables, then relax owner-only tenant-shared memory and editorial approval reads through explicit role checks.

## Block 8 — P1 Backlog Items Landed / Verified

Findings targeted:

- `B-OPUS-P3-1`: verify `loadModelOverrides()` at boot
- `B-OPUS-P1-1`: per-domain pins ignored by the Gemini tier-supplied path
- `B-OPUS-P1-3`: missing warning when Anthropic is configured while `ANTHROPIC_ENABLED=false`
- `B-OPUS-P1-4`: PII scrub needed for search-grounded Gemini one-shot calls
- `F-OPUS-P1-1`: signal source-agent allowlist
- `H-OPUS-P1-1`: memory quota
- `H-OPUS-P1-2`: transactional memory read/touch
- `I-OPUS-P0-2`: concurrent Training cancel race elevated by Opus

Changes:

- Verified `src/services/database.ts` already calls `loadModelOverrides()` after migrations in `initDatabase()`, before provider routing is initialized.
- Updated Gemini tier routing so per-domain operator pins win over explicit `modelTier`.
- Added OpenAI tier-aware domain routing with the same precedence: domain pin, explicit tier, legacy per-domain default.
- Added tests proving Gemini and OpenAI operator domain pins override routing-layer tier decisions.
- Added per-user Training cancellation serialization so concurrent duplicate cancel requests cannot delete the same provider event twice.
- Added an adversarial concurrent-cancel test covering provider delete idempotency.
- Added a source-agent allowlist/format gate to `writeSignal()` so malformed or unregistered signal provenance is rejected before persistence.
- Added memory quota enforcement for active user-private and tenant-shared skill memories, while still allowing correction/replacement of an existing key.
- Moved `getSkillMemories()` read + usage-touch into a single transaction when the DB driver supports transactions.
- Added a Sentry-visible warning when Anthropic is configured as a provider but `ANTHROPIC_ENABLED` is false.
- Added privacy scrubbing before `completeOneShotWithSearch()` sends prompts to Google Search grounding: email, phone-like values, SSN/card-like values, bearer/API keys, token assignments, and URL query strings are redacted before dispatch.

Tests:

- PASS: `npx vitest run __tests__/services/gemini-provider.test.ts __tests__/services/openai-provider.test.ts __tests__/api/training-plan-cancellation.test.ts __tests__/services/tenant-scope-observability.test.ts __tests__/services/skill-memory.test.ts __tests__/services/provider-registry-anthropic-gate.test.ts __tests__/services/provider-registry-fixture-mode.test.ts __tests__/services/signal-ranking.test.ts __tests__/services/cross-agent-learning.test.ts __tests__/services/cross-agent-learning-qa-validation.test.ts`
  - 10 files / 198 tests
- PASS: `npx vitest run __tests__/services/adherence-signals.test.ts __tests__/services/content-radar-preferences.test.ts`
  - 2 files / 35 tests
- PASS: `npx tsc --noEmit`

Commit:

- Pending.

Known follow-ups:

- `B-OPUS-P1-2` live config snapshotting remains deferred; current fixes preserve operator overrides but do not remove live config mutation from `setActiveModel()`.
- Full skill rollout uniqueness still needs a durable schema-level skill identifier on rollout rows before a strict uniqueness constraint can be safely added.
- Memory quota thresholds are conservative code-level guards; tenant-plan-specific quotas can be added once plan entitlements are formalized.

## Full-Suite Regression Repair — 2026-04-29

Context:

- The first full `npm run verify` after Blocks 1-8 exposed test fixtures that still assumed pre-remediation behavior: unauthenticated tool execution, user-only Content signatures, global signal rows in tenant-scoped reads, UTC-only daily-context dates, and Training calendar events created without the Secretary arbitration mock.
- No remediation guard was relaxed to make those tests pass. The fixes aligned tests and fixtures with the stricter backend contracts.

Fixes applied after the first full-suite failure:

- Wrapped Chat-triggered onboarding, Training tool, and general tool-executor tests in explicit chat tool authorization context where the production path requires it.
- Kept explicit no-context adversarial checks using raw `executeToolCall()` and updated them to expect `AUTH_REQUIRED`.
- Updated calendar/mail tool expectations to the user-scoped execution path.
- Updated Content learning route expectations for mandatory `(userId, tenantId)` signatures.
- Updated Content intelligence signal fixtures to include tenant-scoped `agent_signals.tenant_id` rows.
- Updated Content memory tests so tenant-shared memory is read only through the current safe `tenant_id=user_id` owner model until a durable membership table exists.
- Updated Training route tests to mock Secretary scheduling decisions before provider event creation.
- Updated Chat context tests to seed daily context using the app's local-day behavior instead of SQLite UTC `date('now')`.
- Updated direct signal-observability fixtures to include tenant scope.

Regression validation:

- PASS: `npx vitest run __tests__/services/chat-triggered-onboarding.test.ts __tests__/services/training-plans-tools.test.ts __tests__/services/tool-executor.test.ts __tests__/services/content-generation-quality.test.ts __tests__/services/content-memory-profile.test.ts __tests__/api/content-learning-routes.test.ts __tests__/api/content-intelligence-summary.test.ts __tests__/api/content-intelligence-detail.test.ts __tests__/services/signals-observability.test.ts __tests__/api/training-routes.test.ts __tests__/services/chat-context-engine.test.ts`
  - 11 files / 219 tests
- PASS: `npx tsc --noEmit`
- PASS: `npm run verify`
  - TypeScript clean
  - 423 test files / 6,353 tests passed

Release-gate note:

- Backend unit/integration verification is now green for the remediation branch.
- Staging deploy/smoke and the requested external Opus re-audit are still not performed in this local remediation pass. They remain release-process gates, not code-level closures.

## Branch Push, Staging, and Opus Re-Audit — 2026-04-30

Branches and commits:

- Backend branch pushed: `feature/qa-remediation-content-creation-upgrade`
- Backend commit pushed before re-audit: `a59f697`
- iOS branch pushed: `feature/ios-content-creation-intelligence-upgrade`
- iOS commit pushed: `1c06032`
- Local backup refs:
  - backend branch/tag: `backup/codex-pre-push-20260430-0048`, `backup-codex-pre-push-20260430-0048`
  - iOS branch/tag: `backup/ios-pre-push-20260430-0048`, `backup-ios-pre-push-20260430-0048`

Validation:

- PASS: backend pre-commit hook
  - TypeScript clean
  - 423 test files / 6,353 tests passed
- PASS: backend pre-push hook
  - TypeScript clean
  - 423 test files / 6,353 tests passed
- PASS: iOS simulator build
  - `xcodebuild -project "Nexus Hub.xcodeproj" -scheme "Nexus Hub" -sdk iphonesimulator build`
- PASS: iOS simulator test
  - `xcodebuild test -project "Nexus Hub.xcodeproj" -scheme "Nexus Hub" -sdk iphonesimulator -destination "platform=iOS Simulator,name=iPhone 17 Pro"`
- PASS: staging deploy
  - `./scripts/deploy-staging.sh`
  - Staging content engine OK
  - Staging portal OK
  - Production not touched
- PASS: general staging smoke
  - `./scripts/staging-smoke.sh`
  - 17/17 tests passed
  - Staging DB `integrity_check=ok`
- PASS WITH CONDITIONS: focused staging Chat tenant smoke
  - remote staging run of `scripts/chat-tenant-security-smoke.js` against `http://127.0.0.1:8201`
  - 14 pass / 2 partial / 0 fail
  - Partials: admin/support diagnostics token was not supplied to the local-only helper; real provider fallback call was not made.

Read-only Opus re-audit:

- Command: Claude Code `--model opus --effort max`, read-only tools only.
- Verdict: `PASS WITH CONDITIONS`.
- Remaining code P0 found:
  - `A-OPUS-P0-2`: `src/state/shared-memory.ts` preserved only the active value and did not keep correction lineage.
- Remaining code P1 found:
  - `H-OPUS-P1-3`: `src/services/skill-memory.ts` correction history kept only the most recent supersession.
- Documented deferrals that remain accepted release-scope caveats:
  - Training/Cooking/Finance now route primary scheduling paths through Secretary, but legacy Training backfill still writes direct.
  - `setActiveModel()` still mutates live model config instead of per-request snapshotting.
  - `skill_version_rollouts` still needs a durable schema-level skill identifier before strict uniqueness.

Follow-up fixes applied after Opus re-audit:

- Added migration `101_shared_memory_history.sql` with append-only shared-memory correction lineage.
- Updated `setSharedMemory()` to record superseded values in `shared_memory_history` before active-row updates.
- Added `getSharedMemoryHistory()` for support/test inspection.
- Lifted expanded credential-like value rejection into Chat shared memory as a fast-follow hardening improvement.
- Updated `setSkillMemory()` to append existing correction history instead of replacing it with a single latest entry.

Focused validation after follow-up fixes:

- PASS: `npx vitest run __tests__/state/shared-memory.test.ts __tests__/services/skill-memory.test.ts`
  - 2 files / 32 tests
- PASS: `npx tsc --noEmit`

Release-process gates still open:

- Commit and push the follow-up fix commit.
- Re-run full backend `npm run verify` through the normal commit/push hooks.
- Re-run or accept the Opus re-audit delta after the follow-up fixes.
- Take a fresh production DB snapshot immediately before any production deploy.
- Promote only after the exact deployed staging artifact remains accepted.
- Run production health checks after promotion.
