# Nexus Verifiable Reward Loop

Status: canonical
Owner: workspace lead (Felipe)
Last verified: 2026-06-16
Update policy: update when reward verdicts, hard-failure semantics,
agent hooks, score weights, export policy, or calibration/enforcement
rules change.

This protocol defines the Nexus verifier-driven development feedback loop for
Claude Code, Codex, and future coding agents. It is RLVR-inspired, but v1 is
not provider-side reinforcement learning and does not train model weights.

The goal is to improve every deliverable through deterministic project
evidence: tests, scripts, docs, hooks, handoffs, CI/risk gates, and repeated
process updates. Agents improve because their repo instructions, skills, hooks,
handoffs, and gates improve after each verified failure. Provider fine-tuning
is a later, separately approved milestone only.

## 1. Goals and non-goals

Goals:

- Score and classify deliverables with verifiable evidence.
- Make hard failures explicit and impossible to hide behind a high score.
- Give Claude Code and Codex the same workflow, vocabulary, and handoff shape.
- Surface reward summaries in final answers and agent handoffs.
- Turn repeated failures into prompt, skill, hook, gate, test, or doc updates.
- Produce curated eval/fine-tuning-ready data after calibration and human
  review.

Non-goals for v1:

- No provider-side RLVR, RFT, fine-tuning, or weight updates.
- No automatic training job.
- No raw production data, private Telegram content, secrets, or raw production
  logs in reward artifacts.
- No replacement for existing trusted verifiers. `reward-check.mjs` orchestrates
  existing signals instead of reimplementing them.
- No hooks as the only security boundary. Permissions, git hooks, CI, and
  explicit release gates remain the enforcement layer.

## 2. Lifecycle

1. Start every task with the bootloader and current repo state.
2. Choose `area`: `backend`, `ios`, `docs`, `release`, `research`, or `auto`.
3. Run or collect the existing verifiers that match the changed area.
4. Record mandatory checks, optional checks, skipped checks, hard failures,
   evidence, redactions, score, verdict, and export eligibility.
5. Add a compact reward summary to the handoff and final deliverable.
6. For repeated failures, update one or more permanent surfaces:
   prompt text, `AGENTS.md`, `CLAUDE.md`, a skill, a hook, CI/risk gate,
   regression test, or canonical doc.
7. During calibration, manually review all `FAIL`, `MANUAL_REQUIRED`, and
   critical-area `PASS` results.

## 3. CLI contract

Backend implementation entrypoint:

```bash
node scripts/reward-check.mjs --area auto --handoff docs/agents/handoffs/<file>.md --advisory
node scripts/reward-check.mjs --area backend --json --output .local/reward-runs/<run>.json
node scripts/reward-check.mjs --area release --enforce --handoff <path>
```

Supported flags:

- `--area backend|ios|docs|release|research|auto`
- `--handoff <path>`
- `--json`
- `--advisory`
- `--enforce`
- `--output <path>`
- `--changed-files <path>`

Defaults:

- Advisory mode.
- Output under `.local/reward-runs/<timestamp>-<runId>.json`.
- No deploy, staging promotion, production health mutation, physical-device
  interaction, or real provider write.
- Safe local checks may run: git status, changed-area classifier, docs audit,
  schema checks, focused local verifiers, and handoff verification.
- Expensive or environment-bound checks are represented as evidence validation
  against the handoff. Missing mandatory evidence becomes `MANUAL_REQUIRED` or
  `FAIL` based on area/risk.

## 4. Reward run schema

Every run emits a bounded JSON object:

```json
{
  "version": "1.0.0",
  "policyVersion": "2026-06-16",
  "runId": "uuid",
  "timestamp": "ISO-8601",
  "agent": {
    "name": "claude-code | codex | human | unknown",
    "sessionId": "optional",
    "model": "optional"
  },
  "repo": {
    "name": "cortex-telegram-hub-bot",
    "branch": "string",
    "baseRef": "string",
    "headSha": "string or null",
    "dirty": true
  },
  "area": "backend | ios | docs | release | research | auto",
  "changedFiles": [],
  "classifier": {
    "command": "string",
    "versionHash": "sha256 or null",
    "result": {}
  },
  "signals": [],
  "mandatoryChecks": [],
  "optionalChecks": [],
  "skippedChecks": [],
  "hardFailures": [],
  "score": 0,
  "verdict": "PASS | WARN | FAIL | MANUAL_REQUIRED | NOT_APPLICABLE",
  "evidence": [],
  "redactions": [],
  "exportEligibility": {
    "eligible": false,
    "reason": "string"
  }
}
```

Each check object includes:

- `id`
- `label`
- `command`
- `status`: `PASS`, `FAIL`, `SKIPPED`, `ERROR`, or `NOT_APPLICABLE`
- `mandatory`: boolean
- `exitCode`
- `durationMs`
- `evidence`
- `verdictImpact`
- `reason`

Skipped checks are never silent. Each skipped check is classified as:

- acceptable skip
- warning
- manual review required
- hard failure

## 5. Verdict semantics

Verdict is primary. Score is secondary.

- `FAIL`: any hard failure, mandatory command failure, fabricated evidence,
  unsafe operation, or explicitly failed release/security/auth/tenant/deploy
  requirement.
- `MANUAL_REQUIRED`: deterministic verification cannot complete safely or
  mandatory evidence requires human/device/staging/provider proof.
- `WARN`: optional check failure or non-critical hygiene issue.
- `PASS`: required evidence exists and mandatory checks passed.
- `NOT_APPLICABLE`: no meaningful reward check applies.

A high numeric score can never override `FAIL` or `MANUAL_REQUIRED`.

## 6. Score design

The v1 score is 100 points:

- Evidence quality: 35
- Changed-area coverage: 20
- Safety and non-negotiables: 20
- Docs/context hygiene: 15
- Handoff and learning loop: 10

Area interpretation:

- `backend`: typecheck, focused/changed tests, changed-area classifier, risk
  gate, provider routing, auth, tenant isolation, memory/data boundaries.
- `ios`: Xcode build/test runner evidence, simulator interaction, physical
  device, signing, and TestFlight evidence where risk requires them.
- `docs`: docs audit, canonical placement, mirror freshness, no duplicate or
  stale current truth.
- `release`: risk gate, release identity, staging smoke, production health
  evidence, rollback readiness, operator authorization.
- `research`: source quality, citations, observed dates, uncertainty,
  reproducibility, no unsupported claims.

Scores support trend review and calibration. They do not substitute for
mandatory evidence.

## 7. Hard-failure catalog

Seed hard failures from Nexus non-negotiables:

- Touching `.env` or exposing secrets.
- Writing sensitive artifacts outside ignored/approved paths.
- Direct provider API bypass where Nexus requires provider routing
  abstractions.
- Tenant/user isolation bypass.
- Unsafe deploy path or deploy without authorization.
- Missing staging smoke for deploy-critical work without explicit approval.
- Destructive git operation without explicit approval: `git reset --hard`,
  force push, shared-branch rebase, unsafe cleanup, or broad deletion.
- Prohibited `git commit --amend` or `--no-verify` under current policy.
- Unsafe production data or log handling.
- Fabricated test/evidence claims.
- Claiming tests passed without command/evidence.
- Migration changes without migration safety evidence.
- Missing required docs update.
- Any additional blocker in `CLAUDE.md`, `AGENTS.md`, release docs, security
  docs, or engineering standards.

## 8. Mandatory and optional checks

Mandatory checks are determined by area and changed files. Use existing trusted
signals first:

- `scripts/changed-area-classifier.sh --json`
- `scripts/risk-gate.sh --dry-run` for selected commands and cannot-skip gates
- `npm run docs:audit`
- `npm run verify` or focused local test evidence when appropriate
- `scripts/verify-deliverable.mjs` for final handoff claim hygiene
- Release scripts and smoke evidence for release-area work
- iOS build/test runner evidence for iOS work

Optional checks can improve score or produce `WARN`, but optional failure does
not force `FAIL`.

## 9. Handoff integration

Every non-trivial handoff adds:

```markdown
## Verifiable Reward Summary

- Verdict:
- Score:
- Area:
- Changed-area classifier:
- Hard failures:
- Mandatory checks:
- Skipped checks and reasons:
- Evidence commands:
- Evidence artifacts:
- Export eligibility:
- Prompt/process improvement:
```

Raw JSON stays out of normal handoffs. Store raw runs under
`.local/reward-runs/`. Track curated summaries and promoted release evidence
only.

## 10. Hook strategy

Hooks are convenience and visibility, not the only enforcement boundary.

Codex:

- Repo-scoped skill: `.agents/skills/verifiable-reward-check/SKILL.md`.
- Advisory `Stop` hook can run `reward-check`.
- Project hooks require trust review and may be skipped until trusted.
- Enforcement belongs in permissions, approvals, git hooks, CI, and risk gates.

Claude Code:

- Project settings and skills may be committed only when `.gitignore` has exact
  unignore rules for the controlled files.
- Advisory `Stop` hook can run `reward-check`.
- `PreToolUse`/`PostToolUse` hooks may warn, but permissions and CI gates are
  the hard allow/deny layer.

Phase 1 hooks are advisory only. Enforcement waits for calibration.

## 11. Dataset export

The canonical export is provider-neutral Nexus JSONL. Provider-specific formats
are adapters.

Rules:

- No raw secrets.
- No customer data, private Telegram content, raw production logs, OAuth
  tokens, finance values, calendar contents, or raw provider responses.
- No unreviewed handoff text.
- Every exported example requires human review.
- `exportEligibility.eligible` must be true before export.
- Fine-tuning/RFT remains disabled until Felipe explicitly approves a later
  milestone.

Export record shape:

```json
{
  "task": "sanitized task summary",
  "context": "sanitized relevant instruction context",
  "deliverableSummary": "what changed",
  "verifierInput": {},
  "verifierOutput": {},
  "humanLabel": "good | bad | partial",
  "lesson": "what future agents should do differently"
}
```

## 12. Calibration and enforcement

Phase 0: implement docs, schema, scripts, tests, skills, and advisory hooks.

Phase 1 advisory calibration:

- Run for two weeks or 20 non-trivial sessions, whichever comes first.
- Include release, security, auth, tenant isolation, deploy, provider routing,
  memory/data isolation, and migrations if possible.
- Manually review all `FAIL`, `MANUAL_REQUIRED`, and critical-area `PASS`
  results.
- Track false positives and false negatives.
- Promote repeated failures into prompt, skill, hook, CI/risk gate, docs, or
  regression-test updates.

Phase 2 selective enforcement:

- Enforce first for release, production deploy, auth/security, tenant
  isolation, provider routing, memory/data isolation, migrations, `.env`/
  secrets, and destructive git operations.
- Keep docs-only, research, and low-risk refactors advisory or warning-based
  until deterministic verification is reliable.

Phase 3 data flywheel:

- Export curated reviewed data.
- Use exported records for evals or future fine-tuning prep only after manual
  approval.

## 13. Area examples

Backend:

- Classifier says auth/tenant touched.
- Mandatory: focused auth/security tests or risk-gate evidence, docs audit if
  docs changed, handoff evidence.
- Missing tenant evidence: `MANUAL_REQUIRED` or `FAIL`.

iOS:

- SwiftUI navigation change.
- Mandatory: build plus focused XCTest or simulator evidence. Physical device
  evidence becomes mandatory for auth/account switching, APNs, HealthKit, and
  latency claims.

Docs:

- Canonical process doc changed.
- Mandatory: docs index registration, frontmatter, docs audit, mirror refresh
  when workspace source changed.

Release:

- Production promote work.
- Mandatory: authorization, release identity, risk gate, staging smoke,
  production health evidence, rollback readiness. Missing deploy-critical
  evidence is not a pass.

Research:

- Current vendor guidance or model claims.
- Mandatory: source links, observed dates, official/primary sources when
  required, uncertainty, no unsupported claims.
