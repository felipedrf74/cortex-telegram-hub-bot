# Claude Code QA Prompt — Content Token Reduction

You are Claude Code acting as a hostile QA reviewer for Nexus Hub.

## Verdict Required

Reply with one of:

- `PASS`
- `PASS WITH MINOR ISSUES`
- `PARTIAL`
- `FAIL`
- `NOT VERIFIED`

Lead with the verdict, then list findings by severity with file/line citations.

## Original Goal

Felipe asked Codex to implement the complete Content Token Reduction plan for the Content skill. The product goal is to make script generation and content creation viable by substantially reducing token spend while preserving output quality.

The intended architecture is not a prompt-only tweak. It must cover backend TypeScript, Python `content-engine`, and iOS UX:

- draft-first generation by default;
- prompt compiler with per-section budgets;
- stable prompt/cache prefix discipline;
- creator voice card instead of repeated raw profile blobs;
- compact research/source packages;
- research routing before web/deep search;
- cheaper rewrite, expansion, and research refresh paths;
- model-tier routing and token/cost attribution;
- quality gate and kill switches;
- iOS state/cost/research labels;
- direct REST routes only, never fake chat commands.

## Worktrees To Inspect

Backend/content-engine:

`/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot-content-token-reduction`

iOS:

`/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub-content-token-reduction`

Both worktrees are on branch `codex/content-token-reduction`. Main worktrees contain unrelated work from other agents; do not judge this delivery from main.

## What Codex Implemented

### Backend TypeScript

- Added token economy primitives in `src/services/content-token-economy.ts`:
  - `ContentPromptSection`
  - `CompiledContentPrompt`
  - `CreatorVoiceCard`
  - `ResearchRoute`
  - `SourceReference`
  - `ContentQualityResult`
  - prompt section budgeting
  - stable cacheable prefix hash
  - research router
  - source compression/linting
  - deterministic quality gate
  - mode cost estimates and budget states
- Added signed internal attribution support in `src/services/internal-attribution.ts`.
- Added durable artifact support:
  - migration `migrations/136_content_token_reduction_artifacts.sql`;
  - `content_creator_voice_cards`;
  - `content_research_artifacts`;
  - `content_source_packages`;
  - `content_idea_memory`;
  - tenant/user-scoped retrieval helpers in `src/services/content-token-artifact-store.ts`.
- Extended runtime flags in `src/services/runtime-flags.ts`:
  - force draft-only;
  - disable fresh research;
  - disable deep research;
  - disable long-form full scripts;
  - disable model-assisted quality audit.
- Updated `src/api/routes/content-script-routes.ts`:
  - script generation defaults to draft;
  - unsupported topics short-circuit before AI;
  - high-risk topics require acknowledgement before AI;
  - requested/applied mode and downgrade reason are returned;
  - recent idea memory is injected as compact avoidance hints;
  - voice card, source package, research artifact, and idea memory are persisted after successful generation;
  - persisted source/research artifacts can be fetched through authenticated tenant-scoped GET routes:
    - `GET /api/v1/content/source-packages/:id`
    - `GET /api/v1/content/research-artifacts/:id`
  - direct REST edit routes were added:
    - `POST /api/v1/content/script/expand`
    - `POST /api/v1/content/script/rewrite`
    - `POST /api/v1/content/script/research-refresh`
  - expand/rewrite routes use cheap one-shot completion and do not call the full script engine;
  - research refresh is explicit and preserves the current script while replacing compact source notes.
- Updated `src/api/routes/content-script-route-utils.ts`:
  - content metadata includes prompt budget, quality, budget, source summary, cache status, requested/applied mode, and downgrade reason;
  - `SourcePackage` / `ResearchArtifact` public IDs are returned only when persistence succeeds.
- Updated `src/api/routes/internal.ts` and `src/services/content-engine.ts`:
  - content-engine script calls carry server-signed attribution context;
  - report usage can attribute real user/tenant instead of hardcoded system identity when a valid token is present.
- Updated `src/services/content-engine-profile-payload.ts`:
  - content-engine creator context now carries server-signed user/tenant attribution;
  - creator profile reads use the active tenant scope instead of assuming `tenantId === userId`.

### Python Content Engine

- Added `content-engine/services/creative/prompt_compiler.py`.
- Updated `content-engine/services/creative/script_writer.py`:
  - draft-first mode normalization;
  - per-mode output token caps;
  - real compiled prompt metadata from the Python prompt actually sent to the model;
  - source-package compression;
  - research route and quality metadata.
- Updated `content-engine/models/requests.py` and provider client plumbing to carry token/cost/budget metadata.
- Updated `content-engine/routers/research.py` and `content-engine/services/claude_client.py`:
  - body-based content-engine AI endpoints install request-scoped attribution before downstream model calls;
  - `ask_claude` / `ask_claude_json` inherit user, tenant, and attribution token from that request context unless explicitly overridden.

### iOS

- Updated `Nexus Hub/Models/ScriptGenerationMode.swift`:
  - draft-first mode;
  - safe mode decoding;
  - timeout symmetry for draft/standard/deep.
- Updated `Nexus Hub/Core/Services/ContentService.swift`:
  - draft-first request shape;
  - new direct REST calls for expand, rewrite, and research refresh;
  - optional metadata decoding remains backward compatible.
- Updated `Nexus Hub/Core/Repositories/ContentRepository.swift`:
  - repository wrappers for expand/rewrite/research refresh.
- Updated `Nexus Hub/Views/Content/ScriptGeneratorView.swift`:
  - default CTA is draft-first;
  - cost/research/cache/budget/quality/downgrade metadata are surfaced;
  - budget-exhausted blocks generation with semantic copy;
  - expand/rewrite/refresh chips are now actionable buttons, not fake affordances.

## Files Changed

Backend/content-engine changed files:

- `src/services/content-token-economy.ts`
- `src/services/content-token-artifact-store.ts`
- `src/services/internal-attribution.ts`
- `src/services/content-engine-profile-payload.ts`
- `src/services/runtime-flags.ts`
- `src/api/routes/content-script-routes.ts`
- `src/api/routes/content-script-route-utils.ts`
- `src/api/routes/content-generation-meta.ts`
- `src/api/routes/internal.ts`
- `src/services/content-engine.ts`
- `migrations/136_content_token_reduction_artifacts.sql`
- `content-engine/models/requests.py`
- `content-engine/routers/research.py`
- `content-engine/services/claude_client.py`
- `content-engine/services/creative/script_writer.py`
- `content-engine/services/creative/prompt_compiler.py`

Backend/content-engine tests changed or added:

- `__tests__/api/content-generation-meta.test.ts`
- `__tests__/api/content-script-duration.test.ts`
- `__tests__/api/content-script-route-utils.test.ts`
- `__tests__/api/content-topics-recommendation.test.ts`
- `__tests__/api/internal-routes-runtime.test.ts`
- `__tests__/api/internal-routes.test.ts`
- `__tests__/services/content-token-economy.test.ts`
- `__tests__/services/content-token-artifact-store.test.ts`
- `__tests__/services/content-engine-profile-payload.test.ts`
- `__tests__/services/internal-attribution.test.ts`
- `__tests__/services/python-engine-hardening.test.ts`
- `__tests__/services/runtime-flags.test.ts`
- `__tests__/services/script-pipeline.test.ts`
- `content-engine/tests/services/test_remaining_content_modules.py`
- `content-engine/tests/services/creative/test_prompt_compiler.py`

iOS changed files:

- `Nexus Hub/Models/ScriptGenerationMode.swift`
- `Nexus Hub/Core/Services/ContentService.swift`
- `Nexus Hub/Core/Repositories/ContentRepository.swift`
- `Nexus Hub/Views/Content/ScriptGeneratorView.swift`
- `Nexus HubTests/ContentAgencySourcePinsTests.swift`
- `Nexus HubTests/ContentScriptProvenanceDecodingTests.swift`
- `Nexus HubTests/ScriptGenerationModeTests.swift`

## Expected Behavior

- Script generation defaults to a compact Draft Pack, not a full script.
- Deep/full work only happens when the request, policy, budget, and flags allow it.
- Unsupported topics return a safe error before any model call.
- High-risk topics require explicit acknowledgement before any model call.
- Standard mode does not call deep research by default.
- Rewrites and section expansions reuse the current draft/source summary and avoid full research reruns.
- Refresh Research is explicit and returns updated source notes without rewriting the current script.
- Public API responses do not expose raw research dumps, internal debug metadata, provider stack traces, unbacked source package IDs, or internal attribution tokens.
- Persisted research/source artifact IDs are tenant/user-scoped and retrievable only through authenticated direct REST routes.
- Creator voice cards and content idea memory are compact, tenant-scoped artifacts, not repeated raw profile/history blobs.
- iOS displays draft/cost/research/budget/quality/downgrade state honestly.
- iOS expansion option chips perform real REST actions or show in-flight state; they must not be decorative fake buttons.
- Budget-exhausted state prevents generation on iOS instead of allowing a doomed request.
- Token-Zero remains intact: all operational reads/writes use direct REST, not chat commands.

## Tests And Checks Already Performed

Backend/content-engine:

- `npm run typecheck` — PASS.
- `npm run verify` — PASS: 610 files / 9,036 tests.
- `npx vitest run __tests__/api/content-script-duration.test.ts __tests__/api/content-script-route-utils.test.ts __tests__/services/content-token-artifact-store.test.ts __tests__/services/content-token-economy.test.ts __tests__/services/content-engine-profile-payload.test.ts __tests__/services/internal-attribution.test.ts __tests__/services/runtime-flags.test.ts` — PASS: 57 tests.
- `npx vitest run __tests__/services/python-engine-hardening.test.ts` — PASS: 55 tests.
- `npx vitest run __tests__/security` — PASS: 17 files / 87 tests.
- `grep -rc "^[[:space:]]*\\(test\\|it\\)(" __tests__ | awk -F: '{s+=$2} END {print s}'` — reported 7,358 explicit `test` / `it` call sites.
- `content-engine/.venv/bin/python -m pytest content-engine/tests/services/test_remaining_content_modules.py content-engine/tests/services/creative/test_prompt_compiler.py` — PASS: 39 tests.
- `git diff --check` — PASS.

iOS:

- `xcodebuild -project "Nexus Hub.xcodeproj" -scheme "Nexus Hub" -sdk iphonesimulator build` — PASS.
- `xcodebuild test -project "Nexus Hub.xcodeproj" -scheme "Nexus Hub" -sdk iphonesimulator -destination "platform=iOS Simulator,name=iPhone 17 Pro" -only-testing:Nexus\ HubTests/ContentAgencySourcePinsTests -only-testing:Nexus\ HubTests/ContentScriptProvenanceDecodingTests -only-testing:Nexus\ HubTests/ScriptGenerationModeTests` — PASS: 28 tests.
- `git diff --check` — PASS.

Docs workflow:

- Read canonical workspace docs before writing this prompt.
- `cd /Users/felipedominguez/Desktop/Nexus\ Hub/engine && npm run docs:audit` — completed with existing baseline warnings.

Unavailable commands in these worktrees:

- Backend `npm run test:security` and `npm run test:count` are not present in this package.json in the content-token-reduction worktree.
- iOS `./scripts/ios-session-test.sh` and `./scripts/ios-feature-test-convention-check.sh` are not present in the content-token-reduction worktree. The older `scripts/ios-single-simulator-test.sh` does exist, but focused Xcode tests were used for this content-scoped pass.

## Areas To Inspect Carefully

1. **Model spend enforcement**
   - Verify unsupported and high-risk topics short-circuit before `getScript`, `completeOneShotWithFallback`, or provider calls.
   - Confirm deep mode is disabled by budget/flags when appropriate and returns a visible downgrade reason.

2. **Rewrite/expand routes**
   - Confirm `POST /api/v1/content/script/expand` and `/rewrite` do not rerun research or call the full script pipeline.
   - Confirm these routes are authenticated, tenant-scoped, and do not trust user-supplied IDs.
   - Confirm minimal context is sent: current script, topic, action, source summary, voice/format hints.

3. **Research refresh route**
   - Confirm `/research-refresh` is explicit, source-grounded, and does not silently rewrite the script body.
   - Confirm it never exposes raw provider/source payloads.

4. **Prompt compiler truth**
   - Confirm Python `script_writer.py` reports prompt budget and cacheable prefix hash from the prompt actually sent to the model.
   - Confirm TS no longer presents an unrelated prompt hash as provider-cache truth.
   - Check byte stability of cacheable prefix across identical requests.

5. **Source package honesty**
   - Confirm public responses emit `sourcePackageId` and `researchArtifactId` only after `persistContentArtifacts` succeeds.
   - Confirm `GET /api/v1/content/source-packages/:id` and `GET /api/v1/content/research-artifacts/:id` are authenticated, tenant/user-scoped, ID-format guarded, and return safe compact payloads only.
   - Confirm compact `sourceSummary` is safe, bounded, deduped, and reusable, and that persisted artifacts do not contain full raw article/source dumps.

6. **Creator voice card and idea memory**
   - Confirm voice cards are compact persisted artifacts, tenant/user-scoped, and rebuilt from profile/memory/examples without Felipe/operator defaults.
   - Confirm recent idea memory is used only as compact avoidance hints and cannot leak another tenant/user's hooks or angles.

7. **Internal attribution**
   - Confirm HMAC signing is timing-safe, expires correctly, rejects tampering, and cannot be overridden by request body identity.
   - Confirm `/internal/ai-complete`, `/internal/report-usage`, and content-engine script calls use attribution consistently where implemented.
   - Confirm body-based Python content-engine endpoints install and reset request-scoped attribution around AI calls.

8. **iOS UX honesty**
   - Confirm expand/rewrite/refresh chips are actually tappable and call the repository/service route.
   - Confirm budget exhausted blocks generation with localized copy.
   - Confirm downgrade, quality warning, cache/research state, and cost tier copy are user-safe and not raw slugs where visible.

9. **Security and privacy**
   - Inspect for raw research payloads, prompt text, internal model/provider IDs, attribution tokens, stack traces, or unsafe source dumps in API responses and iOS UI.
   - Confirm Token-Zero remains intact: no fake chat commands for content operations.

10. **Tests**
   - Confirm the new focused tests actually fail if the core guarantees are broken.
   - Look for missing route-level tests around unsupported/high-risk edit routes, budget exhaustion, and iOS button actions.

## Edge Cases To Verify

- `mode=deep` while `CONTENT_DISABLE_DEEP_RESEARCH=true` returns draft/downgrade metadata, not hidden full/deep work.
- `CONTENT_FORCE_DRAFT_ONLY=true` downgrades standard/deep and surfaces the reason.
- `CONTENT_DISABLE_MODEL_QUALITY_AUDIT=true` removes model-assisted audit from the response path without disabling deterministic safety checks.
- Unsupported topic such as hacking/stealing/piracy returns a safe error before token spend.
- High-risk topic such as medication, legal, financial, depression, anxiety, blood pressure, dose, or fasting requires acknowledgement or safe constrained handling.
- Rewrite hook/caption/tone actions do not call research.
- Expand section/all actions reuse the current source summary.
- Refresh research updates source notes while preserving the user’s current script body.
- iOS legacy response with no token-economy metadata still decodes and renders.
- iOS unknown budget/cache/research states do not crash and do not display raw internal strings in normal UI.
- Two identical draft requests produce the same cacheable prefix hash, assuming identical voice card and source package inputs.
- A malicious client cannot submit a different userId/tenantId in the body and get attribution for another user.
- A source/research artifact generated for tenant A/user A cannot be fetched by tenant B/user B.
- If artifact persistence fails, the script response still succeeds but does not advertise unbacked artifact IDs.
- A second generation with the same creator should see only compact recent idea-memory avoidance hints, not raw historical scripts or cross-tenant hooks.
- Python `hooks`, `titles`, `caption`, `repurpose`, `feedback`, and similar POST endpoints should forward request-scoped attribution to downstream `ask_claude` calls when the TS layer supplied signed attribution fields.

## Known Risks Or Explicitly Not Claimed

- No production deploy or staging smoke was performed for this content-token-reduction worktree.
- The target 70-85% cost reduction is not claimed as measured production truth yet. It requires staging/prod canary telemetry with real usage.
- Durable database tables now exist for creator voice cards, research artifacts, source packages, and idea memory, but no admin/product editing surface was added. This is intentional for v1.
- Migration number `136_content_token_reduction_artifacts.sql` must be checked against the active merge target before landing, because other parallel feature work may also have introduced a `136_*` migration.
- Provider-native cache read/write metrics are not claimed as complete because current provider adapters do not expose cache usage consistently. This pass makes prompt prefixes stable and reports the real compiled-prompt hash.
- Streaming/early-stop is not implemented; it remains optional P2.
- Content idea memory is lightweight hash/angle/hook memory, not a full semantic embedding store. Deeper semantic memory should be separately designed and tested.
- Request-scoped attribution is wired for body-based Python content-engine POST endpoints. Any legacy GET/query-only content-engine path without a request body should still be inspected before claiming every possible content-engine call is user-attributed.
- The backend worktree does not contain the newer pipeline-hygiene scripts (`test:security`, `test:count`) described in a separate agent handoff; repo state wins.

## Suggested Extra Verification Commands

Backend:

```bash
cd "/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot-content-token-reduction"
git diff --stat
git diff --check
npm run typecheck
npm run verify
npx vitest run __tests__/api/content-script-duration.test.ts \
  __tests__/api/content-script-route-utils.test.ts \
  __tests__/api/internal-routes.test.ts \
  __tests__/api/internal-routes-runtime.test.ts \
  __tests__/services/content-token-artifact-store.test.ts \
  __tests__/services/content-token-economy.test.ts \
  __tests__/services/content-engine-profile-payload.test.ts \
  __tests__/services/internal-attribution.test.ts \
  __tests__/services/runtime-flags.test.ts
npx vitest run __tests__/security
content-engine/.venv/bin/python -m pytest \
  content-engine/tests/services/test_remaining_content_modules.py \
  content-engine/tests/services/creative/test_prompt_compiler.py
```

iOS:

```bash
cd "/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub-content-token-reduction"
git diff --stat
git diff --check
xcodebuild -project "Nexus Hub.xcodeproj" -scheme "Nexus Hub" -sdk iphonesimulator build
xcodebuild test -project "Nexus Hub.xcodeproj" -scheme "Nexus Hub" -sdk iphonesimulator \
  -destination "platform=iOS Simulator,name=iPhone 17 Pro" \
  -only-testing:Nexus\ HubTests/ContentAgencySourcePinsTests \
  -only-testing:Nexus\ HubTests/ContentScriptProvenanceDecodingTests \
  -only-testing:Nexus\ HubTests/ScriptGenerationModeTests
```

## QA Output Format

Use this structure:

```text
VERDICT: PASS | PASS WITH MINOR ISSUES | PARTIAL | FAIL | NOT VERIFIED

Top Findings:
- [severity] [file:line] finding

Verified Behaviors:
- ...

Unverified / Not Claimed:
- ...

Required Fixes Before Merge:
- ...

Recommended Follow-Ups:
- ...
```
