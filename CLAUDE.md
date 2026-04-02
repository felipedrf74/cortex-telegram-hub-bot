# CLAUDE.md — Nexus Hub Development Instructions

## ⚡ AUTONOMOUS AGENT MODE

You are part of a self-orchestrating dev team. You work independently and chain to the next step when done.

### Step 1: Check for task
```bash
cat .agent-prompt.md 2>/dev/null
```
If it exists, read it and execute the task. If not, wait for instructions.

### Step 2: Execute the task
- Read CLAUDE.md and the task prompt
- Implement/test/fix as described
- Run `npx vitest run` and `npx tsc --noEmit` before committing
- Commit and push to your branch

### Step 3: Auto-chain when done
Detect which worktree you're in and run the completion script:
```bash
AGENT_DIR=$(basename "$(pwd)")
node ~/Desktop/Custom\ Connectors/Cortex/cortex-telegram-hub-bot/scripts/agent-complete.js --agent $AGENT_DIR --summary "brief description of what you did"
```
This automatically:
- Updates the Notion card
- Triggers QA validation for feature work
- Queues tasks if QA is busy
- Fetches your next task and writes a new .agent-prompt.md

### Step 4: Continue the loop
After agent-complete.js runs, immediately check for more work:
```bash
cat .agent-prompt.md 2>/dev/null
```
If a new task exists, **read it and execute it immediately** — do not stop or ask.
If no task exists, say "Agent idle — no more tasks in queue" and wait.

### QA Agent: Validation workflow
If you are the QA agent and your prompt says "QA Validation Task":
1. Pull the code from the specified branch
2. Run tests, type check, review code
3. Write additional validation tests if needed
4. When done, run ONE of:
```bash
# Everything passes:
AGENT_DIR=$(basename "$(pwd)")
node ~/Desktop/Custom\ Connectors/Cortex/cortex-telegram-hub-bot/scripts/agent-complete.js --agent $AGENT_DIR --verdict pass
# Something fails:
node ~/Desktop/Custom\ Connectors/Cortex/cortex-telegram-hub-bot/scripts/agent-complete.js --agent $AGENT_DIR --verdict fail --reason "what failed"
```
Then check for the next queued validation task.

### CRITICAL RULES
- **Never stop between tasks** — always check for .agent-prompt.md after completing
- **Never ask for permission** — you have --dangerously-skip-permissions
- **Never merge to main or develop** — only push to your branch
- **Always run tests before committing** — `npx vitest run && npx tsc --noEmit`
- **Always call agent-complete.js when done** — this is how the pipeline chains
- **Always update the Status Portal** — if your feature adds cron jobs, new commands, new integrations, or user-facing functionality, update `src/portal/portal.html` to include it (timeline category, job calendar entry, action button, or status indicator). The portal is the user's dashboard at port 8200.

### QA LEFT-SHIFT POLICY
- **Pre-commit hooks enforce tests** — `vitest run` + `tsc --noEmit` run automatically on every commit
- **QA agent handles integration/E2E testing only** — unit test failures are the committing agent's responsibility
- **Do NOT use `--no-verify`** unless explicitly authorized by Felipe
- If tests fail, fix them before committing. Do not skip.

---

## Project

Nexus Hub (formerly Cortex) — AI-powered creator operating system built with TypeScript, Grammy (Telegram), Anthropic Claude, SQLite, and a Python/FastAPI content engine.

## Repository

- **GitHub:** felipedrf74/cortex-telegram-hub-bot
- **Owner:** Felipe Dominguez
- **License:** MIT (planned)

## Tech Stack

- **Runtime:** Node.js 20+ / TypeScript (CommonJS)
- **Bot:** Grammy (Telegram long polling)
- **AI:** Anthropic Claude (Haiku for classification, Sonnet for domains)
- **Database:** SQLite via better-sqlite3
- **Content Engine:** Python 3.11 / FastAPI (port 8100)
- **Portal:** Express.js (port 8200, same process)
- **Process Manager:** PM2
- **Tests:** Vitest with @vitest/coverage-v8

## Git Workflow

- **main** — Production. CI validates automatically. Deploy is MANUAL (see below).
- **develop** — Integration branch. Merge features here first.
- **feature/NH-xxx-name** — Feature branches. Branch from develop.
- **hotfix/description** — Critical production fixes. Branch from **main**.
- **bugfix/description** — Non-critical bug fixes. Branch from **develop**.

### Commit Convention
Format: `type(scope): description`
Types: feat, fix, refactor, test, docs, ci, chore, perf, style

### Before Pushing
- Run `npx vitest run` — all tests must pass
- Run `npx tsc --noEmit` — no type errors
- Pre-commit and pre-push hooks enforce this automatically

## CI/CD — IMPORTANT

- **CI (automatic):** Runs on every push/PR — lint, typecheck, vitest, build, Python check, migrations. This is the quality gate.
- **CD (MANUAL ONLY):** Server is IPv6-only. GitHub Actions runners cannot reach it. Felipe deploys manually from his Mac using `./scripts/deploy.sh`.
- **Release (manual):** Triggered via GitHub Actions UI.

### What this means for you as an agent:
- **Your job is to make CI pass.** Write code, write tests, push. CI validates automatically.
- **Do NOT attempt deployment.** No SSH to server, no deploy commands, no modifying CD workflow.
- **Do NOT add push triggers to cd-production.yml.** It's manual-only for a reason.
- **See `DEPLOY.md`** for full deployment context if needed.

### Deployment Flow
```
You write code → Push to feature branch → CI validates (automatic)
  → Felipe reviews → Merge to develop → CI validates (automatic)
  → Felipe merges to main → CI validates (automatic)
  → Felipe runs ./scripts/deploy.sh from his Mac → Server updated
```

## Agent Roles

Each Claude Code instance operates as a specialized agent. Know your role:

### Feature Agent (feature/NH-xxx-*)
- Branch from: **develop**
- Merge target: **develop** (Felipe merges)
- Focus: New functionality, architecture changes, new integrations
- Commit prefix: `feat(scope):` or `refactor(scope):`

### Bug Agent (bugfix/*)
- Branch from: **develop**
- Merge target: **develop** (Felipe merges)
- Focus: Fix non-critical bugs, improve error handling, edge cases
- Commit prefix: `fix(scope):`
- Process:
  1. Read the bug description or error log
  2. Write a failing test that reproduces the bug
  3. Fix the bug
  4. Verify the test passes
  5. Check no other tests broke
  6. Commit: `fix(scope): description` with "Fixes #issue" if applicable

### Hotfix Agent (hotfix/*)
- Branch from: **main** (NOT develop — this is production code)
- Merge target: **main** AND **develop** (Felipe merges both)
- Focus: Critical production bugs that need immediate deployment
- Commit prefix: `fix(scope):`
- CRITICAL: Hotfixes must be minimal. Fix ONLY the bug, nothing else.

### Test Agent (feature/NH-xxx-test-*)
- Branch from: **develop**
- Merge target: **develop** (Felipe merges)
- Focus: Expand test coverage, add integration tests, improve mocks
- Commit prefix: `test(scope):`

## Key Architecture

### Three-Tier AI Classification
1. Pattern match (regex, zero cost) → `src/router/classifier.ts`
2. Keyword match (NL, zero cost) → `src/router/classifier.ts`
3. Claude Haiku classification → `src/services/anthropic.ts`

### Domain Handlers
Each domain has isolated conversation history and system prompt:
- Secretary → `src/domains/secretary.ts`
- Triathlon → `src/domains/triathlon.ts`
- Content → `src/domains/content-creator.ts`
- Shared handler → `src/domains/domain-handler.ts`

### Important Files
- `src/config.ts` — All configuration (from .env)
- `src/services/anthropic.ts` — Claude API wrapper
- `src/services/database.ts` — SQLite init + migrations
- `src/services/scheduler.ts` — 18+ cron jobs
- `src/services/tool-executor.ts` — Tool call execution
- `src/portal/telemetry.ts` — Zero-import telemetry (provider callbacks)
- `src/portal/portal.html` — Status Portal UI (port 8200) — MUST update when adding features
- `prompts/*.md` — Hot-reloadable system prompts

### Content Agent Mesh
9 autonomous agents in `src/agents/` communicating via Intelligence Bus (`src/services/intelligence-bus.ts`).

## Testing

```bash
npx vitest run            # Run all tests
npx vitest run --coverage # Run with coverage report
npx vitest                # Watch mode
```

- Tests are in `__tests__/` mirroring `src/` structure
- Setup file: `__tests__/setup.ts` (mocks Anthropic, Grammy, Pino)
- External APIs are ALWAYS mocked — never call real APIs in tests
- Use in-memory SQLite (`:memory:`) for database tests
- **Bug fix rule:** Always write a failing test BEFORE fixing the bug

## Notion Integration

- **Development Board DB:** 332ad49d-23e7-81aa-831e-d5a3ceff20c1
- **Releases DB:** 332ad49d-23e7-8134-b413-d8d3cc3f1a4a

## Server Info (DO NOT attempt to connect)

- Server: `dominguez@serverdominguez` (IPv6-only, local resolution only)
- Path: `/home/dominguez/telegram-hub-bot`
- Backups: `/home/dominguez/backups/nexushub/` (last 10)
- Deploy: Felipe only, via `./scripts/deploy.sh` from Mac

## When You Finish Work — REVIEW HANDOFF

After completing a feature, bugfix, or significant chunk of work, you MUST provide a clear review handoff so Felipe knows exactly what to validate.

### Step 1: Run tests
```
npx vitest run
```

### Step 2: Commit with conventional format
```
git add .
git commit -m "feat(core): add AIProvider interface with fallback logic"
```

### Step 3: Push the branch
```
git push origin $(git branch --show-current)
```

### Step 4: Log completion
```
echo "$(date '+%Y-%m-%d %H:%M') DONE: $(git branch --show-current) — Description" >> ~/Desktop/nexushub-agent-log.md
```

### Step 5: Write acceptance criteria (REQUIRED)

**Before telling Felipe you're done**, provide a clear summary with this exact format:

```
## Review Summary

### What was done
- Brief list of what was implemented/fixed

### Files changed
- List of key files added or modified (not every file — just the important ones)

### Acceptance criteria
- [ ] Criterion 1 — specific, testable condition
- [ ] Criterion 2 — specific, testable condition
- [ ] Criterion 3 — etc.

### Validation steps
1. Step-by-step commands Felipe can run to verify the work
2. Expected output for each step
3. Edge cases to test manually if applicable

### Tests added
- List of new test files or test cases added
- Total test count after your changes

### Breaking changes
- None / List any breaking changes

### Dependencies added
- None / List any new npm packages
```

**Example for a feature agent:**
```
## Review Summary

### What was done
- Implemented AIProvider interface with classify(), chat(), and fallback support
- Created AnthropicProvider wrapping existing Claude API calls
- Created OpenAIProvider for GPT-4o support
- Added FallbackProvider that auto-switches on failure

### Files changed
- src/services/ai-provider.ts (new — interface + base class)
- src/services/providers/anthropic.ts (new)
- src/services/providers/openai.ts (new)
- src/services/providers/fallback.ts (new)

### Acceptance criteria
- [ ] `npx vitest run` passes (all 395+ tests green)
- [ ] `npx tsc --noEmit` passes (no type errors)
- [ ] AIProvider interface exports classify() and chat() methods
- [ ] AnthropicProvider implements the interface using existing Anthropic SDK
- [ ] OpenAIProvider implements the interface (mock-tested, no real API calls)
- [ ] FallbackProvider cascades through providers on failure
- [ ] No changes to existing domain handler behavior

### Validation steps
1. Run `npx vitest run` — expect all tests pass
2. Run `npx tsc --noEmit` — expect no errors
3. Check `git diff main --stat` — see only new files in src/services/providers/
4. Review `src/services/ai-provider.ts` — interface should have classify(), chat()
5. Review `__tests__/services/ai-provider.test.ts` — tests cover fallback cascade

### Tests added
- __tests__/services/ai-provider.test.ts (45 new tests)
- Total: 395 → 440 tests

### Breaking changes
- None — existing Anthropic calls still work, AIProvider is additive

### Dependencies added
- None (OpenAI SDK not added yet — provider is interface-only)
```

**Example for a bug agent:**
```
## Review Summary

### What was done
- Fixed null return when keyword matcher receives empty message
- Fixed regex boundary issue with "3x12 curls" format

### Files changed
- src/router/classifier.ts (2 lines changed)
- __tests__/router/classifier.test.ts (8 new test cases)

### Acceptance criteria
- [ ] `keywordMatch("")` returns null (not throws)
- [ ] `keywordMatch("3x12 curls")` returns "triathlon"
- [ ] All existing 212 classifier tests still pass
- [ ] No type errors

### Validation steps
1. Run `npx vitest run __tests__/router/classifier.test.ts` — all pass
2. Run `npx vitest run` — full suite passes
3. Check `git diff` — only classifier.ts and its test file changed

### Tests added
- 8 new edge case tests in classifier.test.ts
- Total: 395 → 403 tests

### Breaking changes
- None

### Dependencies added
- None
```

### Step 6: Do NOT merge
Felipe reviews and merges. Never merge to develop or main.

## Rules

- Never modify `.env` or `data/` directory
- Never call real external APIs (Anthropic, Microsoft, Google, Garmin) in tests
- Never attempt SSH connections to the server or run deploy commands
- Never modify `cd-production.yml` to add automatic triggers
- Always run tests before committing
- Always provide acceptance criteria when finishing work (see Step 5 above)
- Keep prompts/*.md files — they are hot-reloadable and tracked in git
- Use `os.homedir()` for paths — never hardcode `/home/dominguez` or `/Users/felipedominguez`
- Max 20 conversation messages per domain (auto-pruned by SQLite trigger)
- SQLite: single-file DB, no concurrent writes, use WAL mode
- Bug fixes MUST include a test that fails without the fix and passes with it
- Hotfixes MUST be minimal — fix only the bug, no refactoring
