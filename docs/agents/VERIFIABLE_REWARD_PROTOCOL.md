# Backend Verifiable Reward Protocol Companion

Status: canonical
Owner: backend architecture lead (Felipe)
Last verified: 2026-06-16
Update policy: update when backend-local reward commands, schema, hooks,
or export behavior change. The workspace canonical policy is
`/Users/felipedominguez/Desktop/Nexus Hub/docs/agent/VERIFIABLE_REWARD_PROTOCOL.md`.

This backend companion documents how the Nexus Verifiable Reward Loop is run
inside the backend repo. It does not replace the workspace canonical policy.

## Scope

Applies to backend code, backend docs, release scripts, smoke scripts,
provider routing, auth/session/tenant safety, prompt/context/memory boundaries,
calendar/training/cooking/content/finance/secretary behavior, and backend
agent handoffs.

V1 is local and advisory by default. It is RLVR-inspired, but not provider-side
fine-tuning.

## Backend command contract

Default advisory run:

```bash
npm run reward:check -- --area auto --advisory
```

With JSON output:

```bash
npm run reward:check:json -- --area backend
```

With a handoff:

```bash
node scripts/reward-check.mjs --area auto --handoff docs/agents/handoffs/<file>.md --advisory
```

Enforced mode is reserved for calibrated gates:

```bash
node scripts/reward-check.mjs --area release --enforce --handoff <path>
```

## Existing signals to reuse

`scripts/reward-check.mjs` orchestrates these existing signals instead of
duplicating their logic:

- `git status --short --branch`
- `scripts/changed-area-classifier.sh --json`
- `scripts/risk-gate.sh --dry-run`
- `npm run docs:audit`
- `npm run verify` or focused evidence named by the handoff
- `scripts/verify-deliverable.mjs`
- release identity, staging smoke, production health, and rollback drill
  evidence when area is `release`
- iOS build/test evidence when backend work is paired with an iOS surface

## Verdict priority

Use verdict-first semantics:

- `FAIL` for hard failures, mandatory command failures, fabricated evidence,
  unsafe operations, or failed release/security/auth/tenant/deploy checks.
- `MANUAL_REQUIRED` when proof needs human/device/staging/provider evidence or
  cannot be safely obtained by the local deterministic checker.
- `WARN` for optional-check failure or non-critical hygiene issues.
- `PASS` only when required evidence exists and mandatory checks passed.
- `NOT_APPLICABLE` when no meaningful reward check applies.

The numeric score never overrides a hard failure or missing mandatory evidence.

## Backend hard failures

Hard failures include:

- Touching `.env` or exposing secrets.
- Writing sensitive artifacts outside ignored/approved paths.
- Bypassing provider routing with direct provider APIs in runtime paths.
- Tenant/user isolation bypass.
- Unsafe deploy path or deploy without authorization.
- Missing staging smoke for deploy-critical work without explicit approval.
- `git reset --hard`, force push, shared-branch rebase, broad cleanup, or
  deletion without explicit approval.
- Prohibited `git commit --amend` or `--no-verify`.
- Unsafe production data/log handling.
- Fabricated test/evidence claims.
- Claiming tests passed without command/evidence.
- Migration changes without migration safety evidence.
- Missing required docs update.

## Handoff summary

Add the compact reward block from the workspace handoff template. Raw JSON
stays in `.local/reward-runs/`; tracked handoffs contain only summaries and
links to promoted evidence.

## Export

Use `scripts/export-reward-dataset.mjs` only for reviewed, sanitized,
export-eligible reward runs. The canonical export is provider-neutral Nexus
JSONL. Provider-specific adapters may be added later. Fine-tuning/RFT remains
disabled unless Felipe explicitly approves a later milestone.
