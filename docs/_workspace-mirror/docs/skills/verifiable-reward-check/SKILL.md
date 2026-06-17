---
name: verifiable-reward-check
description: Run the Nexus Verifiable Reward Loop before ending non-trivial Claude Code or Codex work. Use when Felipe mentions rewards, RLVR-inspired checks, verifier-driven development, handoff quality, calibration, enforcement, reward summaries, or when a session produces code, docs, QA, research, release, or process deliverables.
---

# Verifiable Reward Check

Use this skill to apply the Nexus Verifiable Reward Loop. The canonical policy
is `docs/agent/VERIFIABLE_REWARD_PROTOCOL.md`.

## When to run

Run before final handoff/final answer for any non-trivial work:

- Code change.
- Docs/process change.
- QA round.
- Research/audit with source claims.
- Release/deploy work.
- Any session that updates Claude/Codex instructions, skills, hooks, or gates.

Do not use it to claim provider-side RLVR. v1 is local, deterministic, and
advisory unless an explicit calibrated enforcement gate is enabled.

## Area selection

- `backend`: backend code, scripts, tests, provider routing, auth, tenant,
  memory/data boundaries.
- `ios`: Swift/iOS code, Xcode builds/tests, simulator/device evidence.
- `docs`: markdown, canonical docs, bootloaders, indexes, mirror refreshes.
- `release`: staging, production, release identity, smoke evidence, rollback.
- `research`: web/source-backed claims, model/vendor guidance, citations.
- `auto`: let the script infer from changed files.

## Command

Default advisory run:

```bash
node scripts/reward-check.mjs --area auto --advisory
```

With handoff:

```bash
node scripts/reward-check.mjs --area auto --handoff docs/agents/handoffs/<file>.md --advisory
```

JSON output:

```bash
node scripts/reward-check.mjs --area docs --advisory --json
```

Enforcement is only for calibrated gates:

```bash
node scripts/reward-check.mjs --area release --enforce --handoff <path>
```

## Interpret the verdict

- `FAIL`: stop and fix or explicitly report blocker. Score is irrelevant.
- `MANUAL_REQUIRED`: deterministic evidence is insufficient. Report the exact
  human/device/staging/provider proof needed.
- `WARN`: deliverable can be handed off with caveats if no mandatory gate is
  missing.
- `PASS`: mandatory checks and evidence are present.
- `NOT_APPLICABLE`: no meaningful reward check applies.

Never let a high score hide a hard failure, missing mandatory evidence, or
manual-required proof.

## Skipped checks

Document every skipped check as one of:

- acceptable skip
- warning
- manual review required
- hard failure

Do not silently skip release/security/auth/tenant/deploy-critical checks.

## Handoff summary

Add:

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

Keep raw JSON out of handoffs. Raw runs belong under `.local/reward-runs/`.

## Failure response

For each `FAIL` or `MANUAL_REQUIRED`:

1. State the blocker plainly.
2. Link the missing or failing evidence.
3. Add or update a process improvement if the failure is repeatable.
4. Promote repeated failures into one of: prompt update, skill update, hook
   update, CI/risk gate, docs update, or regression test.

## Export eligibility

Only export reviewed, sanitized records. Do not export secrets, raw production
logs, customer data, private Telegram content, raw provider responses, OAuth
tokens, finance values, or unreviewed handoff text. Fine-tuning/RFT remains
disabled until Felipe explicitly approves a later milestone.
