# Closed-beta readiness - Codex independent validation

Date: 2026-05-03
Branch: `feature/closed-beta-readiness-codex-validation`
Base Claude branch: `feature/closed-beta-readiness-hardening`

## Executive summary

- verdict: `READY_WITH_CONDITIONS`
- Claude report confidence: `MEDIUM-HIGH`
- biggest verified fixes: Claude's content-calendar prompt neutralization, voice-evolution `creator_version` read, and identity scanner wiring are valid.
- biggest missed issue: the identity scanner missed legacy runtime content strings such as `ÂNGULO DO FELIPE`, `Felipe's style`, `Felipe's take`, and `Felipe's niches`; one sidecar prompt also assumed the creator was male.
- closed-beta readiness: backend/runtime is ready with conditions after this pass; full closed beta still requires signed-device two-account validation and non-production provider calendar lifecycle smoke.

## Evidence review

| Claude claim | Status | Evidence level | Notes |
| --- | --- | --- | --- |
| Hardcoded Felipe pillars were removed from `content.ts` | VERIFIED | E2 | Focused content/identity suites passed. |
| `voice-evolution-agent` now reads `creator_version` | VERIFIED | E2 | Voice-evolution tests passed. |
| Identity scanner returns 0 flags | VERIFIED AFTER FIX | E2 | Claude's scanner was too narrow; after this pass `scripts/closed-beta-identity-scan.sh --strict --json` returns 0 flags. |
| Training/Secretary orchestration is code-level safe | VERIFIED WITH CONDITIONS | E2/E4 | Calendar sync tests and local cross-skill fixtures passed; no live provider smoke. |
| iOS behavior was not validated by Claude | VERIFIED | E5 after this pass | Codex ran simulator interaction against local engine. |
| Provider-live calendar smoke remains blocked | VERIFIED | E1/E4 | Local fixture calendar path ran; live OAuth credentials were not used. |

## Security and identity

- users tested: local invite users including direct named users `AliceCodex` and `BrunaCodex`
- tenants tested: local chat tenant smoke seeded two isolated user/tenant contexts
- Chat identity: PASS. Direct API `Who am I?` returned Alice for Alice and Bruna for Bruna. Simulator Chat returned only scoped authenticated-session language, with no Felipe leak.
- memory/retrieval: PASS through `scripts/full-nexus-local-engine.sh chat-tenant-smoke`
- prompt context: PASS through tenant smoke and static review
- tool calls: PASS for local forged callback denial and scoped route checks in tenant smoke
- iOS cache: PARTIAL. Simulator showed local `Beta` account and no Felipe data, but true two-account signed-device switch was not run.
- verdict: PASS WITH CONDITIONS

## iOS interaction validation

- local engine: `scripts/full-nexus-local-engine.sh up` on `http://127.0.0.1:8200` with model calls disabled
- simulator/device: iPhone 17 Pro simulator, iOS 26.4, UDID `A0B13967-B5DE-4E6F-897D-F1E409093F94`
- screens tested: Home, Chat, Week agenda, Training, More/Settings, Connections
- interactions: bottom-tab taps, Chat text entry + send, Week open, Training quick action, Connections card open
- navigation stress: 10 rapid bottom-tab taps completed without hang
- account/tenant switch: not available in simulator fixture
- screenshots/logs: XcodeBuildMCP screenshot captured locally; accessibility snapshots confirm rendered states
- verdict: PASS WITH CONDITIONS

## Training + Secretary

- Workflow A-G: backend/API and fixture-level validation only in this pass; iOS Training creation wizard was not exercised end-to-end.
- pass/fail/blocked: PASS for read/render and fixture orchestration; BLOCKED for signed-device/account-switch flow.
- issues found: none new in Training/Secretary code.
- fixes: none in Training/Secretary code.

## Calendar lifecycle

- states tested: local calendar fixture path plus `__tests__/api/training-plan-calendar-sync.test.ts`
- duplicates: covered by focused calendar test suite
- cleanup: local cross-skill smoke dry-run completed; no production calendars used
- sync semantics: local only, no provider-live readback
- verdict: PASS WITH CONDITIONS

## Skill preference ownership

- Secretary: PASS through chat tenant smoke and scoped route review
- Training: PASS through calendar/training tests and local Training summary render
- Cooking: PASS at local authenticated API smoke level
- Finance: PASS at local authenticated API smoke level
- Content: PASS after additional identity-neutralization fixes
- Chat: PASS through direct two-user identity probe and tenant smoke
- verdict: PASS WITH CONDITIONS

## Runtime performance

Endpoint sample against local engine:

| Endpoint | Status | Latency | Payload |
| --- | ---: | ---: | ---: |
| `/api/v1/dashboard` | 200 | 31 ms | 1632 bytes |
| `/api/v1/plan/week` | 200 | 2 ms | 6901 bytes |
| `/api/v1/training/summary` | 200 | 2 ms | 31778 bytes |
| `/api/v1/tasks/lists` | 200 | 1 ms | 123 bytes |
| `/api/v1/settings/connections` | 200 | 1 ms | 91 bytes |

No simple-read path in this sample triggered a model/provider call; local provider routing was fixture-only.

## New findings

### P0

- none

### P1

- `CB-CODEX-P1-01`: Claude's identity scanner did not cover legacy Content runtime strings. Evidence: `src/services/content-telegram-formatter.ts`, `content-engine/models/research.py`, `content-engine/models/scoring.py`, and `src/services/cross-agent-learning.ts` still contained founder-specific wording or labels. Status: fixed.

### P2

- `CB-CODEX-P2-01`: `content-engine/services/orchestrator.py` used male creator pronouns in a live AI prompt. This is not a direct Felipe leak but can steer output incorrectly for other creators. Status: fixed.
- `CB-CODEX-P2-02`: full signed-device two-account switch remains unvalidated. Status: open condition.

### P3

- stale design doc under `prompts/` was moved to archive so future runtime prompt sweeps do not need a broad allowlist.

## Fixes implemented

### Fix 1 - Broaden closed-beta identity scanner

- files: `scripts/closed-beta-identity-scan.sh`
- root cause: scanner only detected the narrow v4.14.118 phrase family.
- summary: added legacy Content identity patterns, removed the stale `prompts/daily-content-discovery.md` allowlist, and excluded generated/venv directories for speed.
- test: `__tests__/services/content-telegram-formatter-identity.test.ts`
- validation: scanner strict mode reports 0 flags.

### Fix 2 - Render legacy deep-search angle labels neutrally

- files: `src/services/content-telegram-formatter.ts`
- root cause: old persisted briefings can contain `ÂNGULO DO FELIPE:`.
- summary: parser accepts that legacy label only as a backward-compatible input and renders it as `SEU ÂNGULO`.
- test: `content Telegram formatter identity safety > renders legacy Felipe angle labels as neutral creator-facing copy`
- validation: focused suite passed.

### Fix 3 - Neutralize residual creator wording

- files: `content-engine/models/research.py`, `content-engine/models/scoring.py`, `src/services/cross-agent-learning.ts`, `content-engine/services/orchestrator.py`
- root cause: comments and one live sidecar prompt still encoded founder-specific or male-default creator language.
- summary: replaced with authenticated-creator wording and gender-neutral pronouns.
- test: scanner strict mode.
- validation: scanner strict mode and typecheck passed.

### Fix 4 - Archive stale prompt doc

- files: `docs/archive/2026-05/content/daily-content-discovery.md`
- root cause: stale Felipe-specific design doc lived under runtime `prompts/`.
- summary: moved it to archive so active prompt sweeps stay trustworthy.
- test: docs audit completed with only historical warnings; after adding this archive report the current count is 450 warnings.
- validation: `npm run docs:audit` completed.

## Tests and smoke

- `npx tsc --noEmit`: passed.
- `npx vitest run __tests__/agents/voice-evolution-agent.test.ts __tests__/agents/voice-evolution-qa-validation.test.ts __tests__/security/p0-chat-identity-isolation.test.ts __tests__/services/content-telegram-formatter-identity.test.ts __tests__/api/training-plan-calendar-sync.test.ts --reporter=default`: 5 files / 75 tests passed.
- `scripts/closed-beta-identity-scan.sh --strict --json`: 0 flags.
- `scripts/full-nexus-local-engine.sh smoke`: 13 authenticated API checks passed.
- `scripts/full-nexus-local-engine.sh chat-tenant-smoke`: PASS WITH CONDITIONS; 15 pass, 1 partial, 0 fail.
- `scripts/full-nexus-local-engine.sh chat-eval`: deterministic Chat baseline PASS.
- `scripts/full-nexus-local-engine.sh cross-skill-fixtures`: fixture checks passed; staging runtime section intentionally blocked in local dry-run.
- `npm run docs:audit`: completed with 450 historical warnings.
- iOS simulator build: passed.

## Cleanup status

- services: stopped; local `node dist/index.js` / `npm start` process from attached engine mode was terminated after validation.
- simulators: shut down with `xcrun simctl shutdown all`; no booted devices remain.
- ports: `8200` and `8326` verified clear after cleanup.
- processes: no orphan Nexus/content/training/cooking local processes left from this pass.

## Final recommendation

`READY_WITH_CONDITIONS`

Conditions before `READY_FOR_CLOSED_BETA`:

1. Signed-device or TestFlight two-account switch with Felipe, Jaqueline, and `nexushubbot`.
2. Live non-production Google/Outlook calendar lifecycle smoke with provider readback.
3. Owner review and merge of `feature/closed-beta-readiness-codex-validation`.

## Next actions

1. Review and merge this branch after owner approval.
2. Run signed-device two-account identity/cache validation.
3. Provision non-production provider credentials and run calendar lifecycle smoke.
4. Consider making the closed-beta identity scan strict on PR after a short soak.
