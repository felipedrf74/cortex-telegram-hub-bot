# Agent Process Standard

Status: canonical
Owner: workspace lead (Felipe)
Last verified: 2026-06-24
Update policy: update when a recurring agent failure mode is closed via
process, or when a new evidence type is required. The companion docs are
`docs/agent/OPERATING_CONTEXT.md` (workspace bootloader) and
`docs/release/codex-deploy-process-brief.md` (deploy-specific brief).

This standard is what every Claude Code or Codex run on Nexus Hub must
honor. It exists because past agent runs repeatedly:

- Validated frontend by app launch only (proved nothing).
- Stopped after each phase to ask for approval (created friction without
  reducing risk).
- Chose the easier task in scope when a higher-priority risk was open.
- Created scattered `*-final-report.md` files instead of updating
  canonical docs.
- Hardcoded Felipe's identity into prompts/fixtures (4.14.118 class).
- Skipped real iOS interaction validation.
- Trusted commit messages over code-level evidence.
- Left simulators / DBs / tunnels / provider loops running.

Each rule below is a direct response to an actual past failure.

## 1. Workspace and bootloader (must)

1. **Start from `/Users/felipedominguez/Desktop/Nexus Hub`** — never from
   the legacy `cortex-telegram-hub-bot` path or from a scattered
   `beta-agent` folder.
2. **Read in order** before doing anything else:
   1. `docs/DOCS_INDEX.md`
   2. `docs/agent/OPERATING_CONTEXT.md`
   3. `docs/agent/AGENT_PROCESS_STANDARD.md`
   4. `docs/agent/AGENT_TECHNICAL_MASTERY.md`
   5. `docs/release/CURRENT_RELEASE_STATE.md`
   6. `docs/release/OPEN_ITEMS.md`
   7. The repo-local `CLAUDE.md` for the area you'll touch
      (`engine/CLAUDE.md`, `ios/CLAUDE.md`).
3. **Then read the engineering standard for the area you'll touch:**
   - iOS architecture: `ios/docs/engineering/ios-architecture-and-swiftui-performance-standard.md`
   - iOS validation: `ios/docs/engineering/ios-frontend-validation-checklist.md`
   - Backend API: `engine/docs/engineering/backend-api-contract-standard.md`
   - Security: `engine/docs/engineering/security-and-data-isolation-standard.md`
   - Runtime/Ops: `engine/docs/engineering/runtime-and-observability-standard.md`
   - Testing: `engine/docs/engineering/testing-and-qa-harness-standard.md`
4. **Run `cd engine && npm run docs:audit`** before creating any release
   doc or copying verdicts/test counts.

## 2. Continuous-run discipline (must)

Agents do not stop just to give progress updates. The only legitimate
reasons to halt mid-task:

1. The task is complete.
2. A hard blocker prevents progress (missing credentials, missing OAuth
   secrets, broken local environment).
3. A P0/P1 risk is uncovered that requires Felipe's approval before
   continuing (e.g. a finding that requires touching production).
4. A risky broad redesign would be required (e.g. "the schema has a
   foundational defect" — pause, write the analysis, ask).

Halting because "I should give an update" is **not** an acceptable
reason. Update via brief `★ Insight` blocks during work, not by
stopping.

## 3. Effort tier (must)

Use **Claude Opus 4.7** with **xhigh effort by default**, **max effort**
for:

- iOS architecture and SwiftUI performance standards.
- Backend/API architecture standards.
- Security and data-isolation standards.
- Auth/session/tool-call safety standards.
- Release/CI/CD quality gates.
- Final synthesis.

Subagents that handle critical work must also use Claude Opus 4.7 with
xhigh or max effort. Haiku/Sonnet/lightweight tiers are forbidden for
critical security, architecture, or release work.

When subagents are unavailable, the parent agent runs each scope
sequentially itself at the required effort tier.

## 4. Specialist subagent roster (recommended)

For multi-domain hardening passes, the canonical roster is:

1. **iOS Architecture + SwiftUI Performance**
2. **Backend / API Architecture**
3. **Security / Auth / Tenant Isolation**
4. **Data / Memory / Prompt Context**
5. **Observability / Runtime Reliability**
6. **Testing / QA Harness**
7. **Release Pipeline / Docs Hygiene**
8. **Agent Prompt / Process Improvement**

Each subagent gets:

- A self-contained brief (file paths, line numbers, what to change).
- Hard non-negotiables explicitly listed.
- A required output shape (JSON or fenced markdown).
- A confidence rating per finding.

## 5. Two-agent validation pattern (must, for release-gate work)

The pattern that closes more bugs than any single agent:

1. **Claude implements / hardens.** Lands fixes on
   `feature/<workstream>-<workspace-name>` with backup tag.
2. **Codex independently validates / refutes / fixes confirmed gaps.**
   Lands additional fixes on
   `feature/<workstream>-codex-validation`. Codex is given the same
   workspace bootloader and the Claude PR diff, but **not** Claude's
   internal reasoning.
3. **Both run focused tests, full regression on RC, staging smoke,
   production health (where applicable).**
4. **Final verdict requires BOTH** to land their respective branches
   and to update `docs/release/CURRENT_RELEASE_STATE.md` with the
   merged commit identity.

This is the pattern used for the 4.14.127 auth-hardening pass and the
training expert-coach hostile-QA closeout.

## 6. Evidence levels (must)

Every claim agents make is tagged with an evidence level. The system
mirrors the iOS frontend-validation checklist but applies to all
workstreams:

| Level | Name | What it is |
|---|---|---|
| **E0** | Build/typecheck only | `npx tsc --noEmit` clean, code compiles. Proves nothing about behavior. NOT acceptable on its own. |
| **E1** | Unit / contract test | Vitest test, XCTest, contract decoder. Acceptable for pure logic and DTO changes. |
| **E2** | Integration test or simulator workflow | Vitest integration with `:memory:` SQLite, XCUITest on simulator. Acceptable for most route + UI changes. |
| **E3** | Local smoke OR physical-device interaction | `npm run smoke:*` against local backend, OR a documented physical-device walk-through. Required for cross-route or device-specific changes. |
| **E4** | Staging smoke + production health | Staging smoke 17/17 + `/api/health` + PM2 state. Required for any production deploy. |
| **E5** | Two-account device walk-through OR signed TestFlight | Required for tenant isolation, account switching, auth lifecycle, APNs. |

Agents tag every claim:

```
- Login error parity collapsed to "Invalid email or password" — E1
  (`AuthUserPresentationTests` 8/8 PASS).
- iOS Keychain `…ThisDeviceOnly` flag — E1+E2 (`KeychainHelperTests`
  5/5 PASS, simulator build clean).
- Two-account walk-through for "Who am I?" — REQUIRED, BLOCKED on
  signed iOS build.
```

Claims at E5 that are blocked must be flagged in OPEN_ITEMS.md, not
silently dropped.

## 7. Frontend validation language (must)

Past agent runs claimed "iOS validated" based on a successful build.
Going forward, an agent claim about iOS behavior must specify:

- The evidence level (E1 / E2 / E3 / E4 / E5).
- The exact test file path or device UDID + steps.
- What the test/walk-through asserted.
- Whether two-account validation was performed.

A bare "iOS tests passed" with no file path or count is rejected. The
canonical phrasing patterns:

> ✅ ACCEPTABLE
> "iOS focused tests **23/23 PASS** across 5 suites
> (`KeychainHelperTests` 5, `AuthManagerFixtureLeakTests` 3,
> `AuthManagerPersistenceTests` 4, `AuthUserPresentationTests` 8,
> `GoogleAuthCallbackResolverTests` 3) on iPhone 17 Pro Max simulator
> UDID `4E6C6A6C-…`."

> ❌ NOT ACCEPTABLE
> "iOS tests passed."

> ❌ NOT ACCEPTABLE
> "iOS app builds and launches without crashes."

For workflow-heavy skills such as Content Creation, Finance, Cooking, and
Training, navigation is not validation. A release claim must exercise every
section with realistic dummy data: create or seed entries, save them, read
them back, run the workflow action, and inspect the semantic output against
the active profile. For Content Creation specifically this means Profile &
Voice, References, Radar, Ideas Pipeline, Briefs, Script Studio, Calendar,
Performance, Memory/Feedback, and any integrations/settings surface. Empty
cards, screenshots of static UI, or "renders without crashing" do not count.

## 8. Hard non-negotiables (must — release blockers)

These are forbidden in every agent run unless Felipe explicitly
authorizes the specific exception:

- ❌ `git push` without owner authorization.
- ❌ `./scripts/deploy.sh`, `./scripts/promote-to-prod.sh`,
   `./scripts/deploy-staging.sh` without owner authorization.
- ❌ Use of production data for validation.
- ❌ Use of production calendars / OAuth tokens / user accounts.
- ❌ `git push --force` or any force-update.
- ❌ `git rebase` on a shared branch.
- ❌ `git commit --amend` after a previous commit was pushed.
- ❌ `git reset --hard` outside an explicit recovery context.
- ❌ Removing CI jobs or weakening release gates.
- ❌ Faking test results (claiming N pass when N pass-and-skip ran).
- ❌ Claiming iOS validation from app launch only.
- ❌ Claiming portal validation from shell load only.
- ❌ Weakening tenant/auth/memory/calendar/provider isolation.
- ❌ Logging secrets / raw tokens / finance values / calendar
   contents / private user data.
- ❌ Creating scattered `*-final-report.md` / `*-audit.md` /
   `*-open-items.md` files when a canonical doc already exists.
- ❌ Leaving simulators, DBs, workers, tunnels, or provider loops
   running after a session.

## 9. Canonical-docs rule (must)

When an agent finishes a workstream:

1. **Update the canonical docs first.** `docs/release/CURRENT_RELEASE_STATE.md`
   for release truth, `docs/release/OPEN_ITEMS.md` for new items.
2. **One-off historical evidence goes to `docs/archive/YYYY-MM/<workstream>/`.**
3. **Never duplicate a verdict across multiple "current" files.** If
   the verdict needs to be visible in a per-domain doc, link back to
   the workspace-level CURRENT_RELEASE_STATE.
4. **Do not hand-type the generated release identity block.** Use
   `engine/scripts/release-identity.sh --persist` for branch / SHA /
   version / migration identity. If a manually maintained status section
   needs a test count or rollout summary, run `cd engine && npm run
   docs:audit` first and keep the exact identity delegated to
   `docs/release/release-identity.md`.
5. **Run `cd engine && npm run docs:audit`** and reduce the warning
   count (or document why it grew).
6. **Coverage thresholds ratchet monthly.** The backend coverage baseline is
   recorded on the B2 coverage-threshold source branch until that branch is
   merged; run `cd engine && npx vitest run --coverage` before changing
   thresholds. If the previous month stayed green, raise each global threshold
   by one percentage point until the suite stabilizes near real coverage.
7. **Avoid new partial `vi.mock(...)` factories.** Use the shared
   `engine/__tests__/__mocks__/<module>.ts` factory when one exists, or
   spread the real module with `vi.importActual` before overriding specific
   exports. The strict lint gate is capped by `engine/scripts/.vi-mock-baseline.txt`;
   lower that baseline monthly by at least 10 until it is below 100. Batch 13
   lowered the source-stack baseline from 655 to 640; the monthly target
   remains fewer than 100 partial mocks by 2026-08-01.
8. **Canonical engine docs require frontmatter.** Every non-archive,
   non-mirror `engine/docs/**/*.md` file must carry `Status:`, `Owner:`,
   `Last verified:`, and `Update policy:` near the top. The docs audit treats
   missing canonical engine frontmatter as an error; archives and workspace
   mirror snapshots are intentionally exempt.
9. **Workspace and iOS canonical docs require frontmatter.** Batch 12 extends
   the same error-severity check to workspace `docs/agent/**`,
   `docs/release/**`, `docs/DOCS_INDEX.md`, root bootloaders, iOS engineering
   docs, `ios/docs/qa/QA_IOS_REPORT.md`, and
   `ios-specs/00-CURRENT-PRODUCT-TRUTH.md`. Generated
   `docs/release/release-identity.md` remains exempt because the release
   identity script owns that file.

## 10. Issue ledger closure (must)

Every issue surfaced during an agent run gets a deterministic ID and a
verdict line in OPEN_ITEMS.md:

```
| ID | Severity | Description |
|---|---|---|
| AUTH-EXAMPLE-O1 | P0 | Apple Sign In nonce contract... — FIXED in `<release>` (`<sha>`). |
| AUTH-EXAMPLE-O2 | P0 | Password reset flow missing. — OPEN, see plan in §X. |
```

Closing an item without explicitly marking it closed in OPEN_ITEMS is
forbidden. Items at P0 cannot be closed without a regression test that
fails before the fix and passes after.

## 11. Cleanup contract (must)

After every agent session:

1. **Stop local backend** if started (`pm2 stop nexus-hub` or
   `kill $(pgrep -f "node.*src/index")`).
2. **Stop content-engine subprocess** if started.
3. **Stop workers/queues** if started.
4. **Stop any DB containers** if started (Nexus uses SQLite-on-disk so
   typically nothing to stop here, but Cooking portal browser smoke can
   leave Playwright running).
5. **Stop any tunnels** if started (Cloudflare Tunnel: not started by
   agents).
6. **Stop provider-call loops** if started (test scripts that hit
   real Anthropic/Gemini/OpenAI in a loop).
7. **Shut down only simulators this session owns.** Prefer UDID-specific
   cleanup (`xcrun simctl shutdown <UDID>` and, for throwaway E2E devices,
   `xcrun simctl delete <UDID>`). Do not run `xcrun simctl shutdown all`
   when another worktree or human session may be using Simulator.
8. **Verify ports are clear** for the dev port range (8200 portal, 8201
   staging, 8203 dev backend).
9. **Verify no orphan processes**:
   ```bash
   pgrep -lf "node|xcodebuild|xctrace|playwright|vitest|tsx"
   ```
   Expected: only the user's IDE/agent processes; nothing from this
   session.
10. **Document cleanup in the agent's final report.**

## 12. Prompt self-improvement (must)

Every agent run that produces a non-trivial output must end with a
"prompt/process improvements" section. Required items:

- Checks that were missing from this prompt.
- Tests that should be permanent regressions.
- Release classifier additions.
- Frontend workflow gaps.
- Backend contract gaps.
- Security monitoring gaps.
- iOS validation improvements.
- Portal validation improvements.
- Future Claude/Codex prompt-text additions.

The improvements are then folded into the next iteration of this
standard or the relevant per-domain standard. **Every run leaves the
process slightly better.** Skipping this section is forbidden.

## 13. Claude Code implementation prompt template

The recommended shape for an implementation-mode Claude prompt:

```
<role>
You are Claude Code working in the Nexus Hub workspace.
Acting as: <role list>
Workspace: /Users/felipedominguez/Desktop/Nexus Hub
</role>

<read_first>
1. docs/DOCS_INDEX.md
2. docs/agent/OPERATING_CONTEXT.md
3. docs/agent/AGENT_PROCESS_STANDARD.md
4. docs/release/CURRENT_RELEASE_STATE.md
5. docs/release/OPEN_ITEMS.md
6. The relevant engineering standard(s) under engine/docs/engineering/
   or ios/docs/engineering/
</read_first>

<model_and_effort>
Use Claude Opus 4.7. xhigh by default; max for security/architecture
work.
</model_and_effort>

<task>
<concrete description, with file paths and line numbers>
</task>

<hard_constraints>
- No push, no deploy, no production data.
- No force-push, rebase, amend.
- No removed CI jobs.
- No fake test results.
- No iOS launch-only validation claims.
</hard_constraints>

<evidence_required>
- E1 minimum for pure-logic changes.
- E2 minimum for new routes / new views.
- E3 minimum for cross-route or device-specific.
- E5 for tenant/auth/account-switch.
</evidence_required>

<deliverable>
- Updated canonical docs (no scattered reports).
- Code/process improvements where safe.
- Tests or test recommendations.
- Final report with verdict + open items + prompt improvements.
</deliverable>
```

## 14. Codex adversarial validation prompt template

The recommended shape for a Codex validation-mode prompt:

```
<role>
You are Codex. You are NOT given Claude's internal reasoning.
You are given:
  - The same workspace bootloader as Claude.
  - The Claude PR diff.
  - The Claude final report.
You are validating, refuting, or extending — NOT trusting.
</role>

<read_first>
Same as Claude.
</read_first>

<task>
1. Read the Claude diff with adversarial intent: assume each fix is
   incomplete, each test pins the wrong thing, each evidence claim is
   exaggerated.
2. For every claim of FIXED, verify the failing test before the fix
   exists and is the right shape.
3. For every claim of test count or PASS, re-run the suite locally.
4. For every claim of "no behavior change", read the call sites.
5. Identify what Claude missed: open the same code Claude touched and
   walk one layer deeper.
6. Land additional fixes on feature/<workstream>-codex-validation with
   backup tag.
</task>

<hard_constraints>
Same as Claude.
</hard_constraints>

<deliverable>
- Validation report on the Claude work (CONFIRMED / REFUTED / EXTENDED
  per item).
- Additional fixes if needed.
- Updated OPEN_ITEMS.md if new items found.
</deliverable>
```

## 15. Confidence rating (should)

Findings tagged by confidence:

| Confidence | Meaning |
|---|---|
| **HIGH** | I read the code, ran the test, confirmed both directions of the assertion. |
| **MEDIUM** | I read the code, the test exists but I did not run it; OR I ran the test but did not read every call site. |
| **LOW** | I have a strong hypothesis but did not fully verify. The next step is documented. |
| **SPECULATIVE** | This is a guess based on the symptom; root cause not located. |

P0 items at LOW or SPECULATIVE require an explicit "next step to
escalate to HIGH" before the agent finishes the run.

## 16. Forbidden agent patterns

- ❌ Stopping mid-task to ask "should I continue?"
- ❌ Choosing easier docs cleanup while a P0/P1 architecture/security
   item remains open.
- ❌ Producing a report at the end without any landed fixes when safe
   improvements were available.
- ❌ Claiming validation without recording the evidence file/UDID/steps.
- ❌ Trusting commit messages over reading the diff.
- ❌ Claiming "no behavior change" without listing the call sites
   considered.
- ❌ Asking the user to confirm before reading the workspace docs.
- ❌ Skipping cleanup with "I'll let the user clean up".

## 17. PR description template

When opening a PR (only when the user explicitly authorizes the push):

```
## Summary
<one-line>

## Changes
- <bullet> — <evidence level> — <file path>

## Verification
<the evidence block from §16 of the testing standard>

## Open items
<list any deferred items as they appear in OPEN_ITEMS.md>

## Prompt / process improvements
<list 1-3 improvements for the next agent run>
```

## 18. Per-run completion checklist

Before declaring a run complete:

- [ ] Canonical docs updated (or explicit reason not to).
- [ ] OPEN_ITEMS.md reflects every uncovered finding.
- [ ] Evidence block present in the final report.
- [ ] Cleanup performed and documented.
- [ ] Prompt/process improvements section present.
- [ ] No simulator/DB/tunnel/loop owned by this run left running.
- [ ] No `git push` without authorization (typically: ZERO pushes).
- [ ] No deploy without authorization (typically: ZERO deploys).
- [ ] Backup tag exists for any branch with uncommitted work.

## 19. Skills (callable working patterns)

The catalogue lives at `docs/skills/SKILLS_INDEX.md`. Skills are
**callable patterns** — small, optional behaviors invoked on demand. They
sit on top of this standard, not in place of it. The standard is
non-optional governance baseline; skills are tools.

### Defaults baked into our way of working

1. **Before producing a plan for a non-trivial change**, default to
   [`/grill-me`](../skills/grill-me/SKILL.md) — one question at a time,
   each with a recommended answer. Misalignment caught at planning time
   costs one conversation; misalignment caught after implementation costs
   the whole round trip.
2. **Before debugging anything described as flaky / lag / regression**,
   follow [`/diagnose`](../skills/diagnose/SKILL.md) Phase 1 (build a
   feedback loop) before speculating. Phase 1 is the actual skill;
   everything after it is mechanical.
3. **For long Claude↔Codex handoff prompts**, prefer
   [`/caveman`](../skills/caveman/SKILL.md) once context is established.
   Drop caveman for security warnings, irreversible action confirmations,
   and multi-step sequences where fragment order risks misread.
4. **Hard-to-reverse decisions** captured during grilling or architecture
   review go into `docs/adr/` (see `docs/adr/README.md`). Don't ADR
   ephemeral decisions.

### Trigger phrases (router)

| You / Felipe says… | Reach for |
| --- | --- |
| "grill me", "stress-test this plan", "challenge my design" | [grill-me](../skills/grill-me/SKILL.md) |
| "grill me and capture the decisions", "update the glossary as we go" | [grill-with-docs](../skills/grill-with-docs/SKILL.md) |
| "diagnose this", "debug this", "why is X slow / failing / regressing?" | [diagnose](../skills/diagnose/SKILL.md) |
| "caveman", "be brief", "less tokens", any long-running handoff | [caveman](../skills/caveman/SKILL.md) |
| "zoom out", "give me the bigger picture", "I don't know this code" | [zoom-out](../skills/zoom-out/SKILL.md) |
| "prototype this", "throwaway", "let me play with it" | [prototype](../skills/prototype/SKILL.md) |
| "tdd", "red-green-refactor", "test-first" | [tdd](../skills/tdd/SKILL.md) |
| "improve architecture", "ball of mud", "deepen this module" | [improve-codebase-architecture](../skills/improve-codebase-architecture/SKILL.md) |
| "write a new skill", "add a skill for…" | [write-a-skill](../skills/write-a-skill/SKILL.md) |

### Composition

Skills compose. A real session often runs:

1. `/grill-me` to align on the change.
2. `/prototype` to flush out an unknown.
3. `/tdd` to land the change one vertical slice at a time.
4. `/diagnose` if a regression surfaces during validation.
5. `/improve-codebase-architecture` after the fix is in, to flag
   structural follow-ups (see Phase 6 of `/diagnose`).

The `★ Insight` blocks called out in §2 are the natural narration layer
between skill invocations.

### Out of scope for skills

Skills do **not** replace:

- Section 6 evidence levels (E0–E7).
- Section 8 hard non-negotiables (no push without authorization, no
  deploy without authorization, etc.).
- Section 11 cleanup contract.
- The `cd engine && npm run docs:audit` gate.

If a skill body ever appears to override one of these, the standard wins.
