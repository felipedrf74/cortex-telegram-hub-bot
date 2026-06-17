---
name: verifiable-reward-check
description: Run the Nexus Verifiable Reward Loop before ending non-trivial Codex backend work. Use when Felipe mentions rewards, RLVR-inspired checks, verifier-driven development, handoff quality, calibration, enforcement, reward summaries, or when a backend session produces code, docs, QA, research, release, or process deliverables.
---

# Verifiable Reward Check

Use the backend companion at `docs/agents/VERIFIABLE_REWARD_PROTOCOL.md` and
the workspace canonical policy at
`/Users/felipedominguez/Desktop/Nexus Hub/docs/agent/VERIFIABLE_REWARD_PROTOCOL.md`.

Run before final handoff/final answer for non-trivial work:

```bash
node scripts/reward-check.mjs --area auto --advisory
```

With a handoff:

```bash
node scripts/reward-check.mjs --area auto --handoff docs/agents/handoffs/<file>.md --advisory
```

Interpret verdicts before scores:

- `FAIL`: fix or report a blocker.
- `MANUAL_REQUIRED`: name the missing human/device/staging/provider evidence.
- `WARN`: hand off with caveats if mandatory gates are satisfied.
- `PASS`: required evidence exists and mandatory checks passed.
- `NOT_APPLICABLE`: no meaningful reward check applies.

Document skipped checks as acceptable skip, warning, manual review required, or
hard failure. Add the Verifiable Reward Summary block to handoffs. Keep raw
JSON under `.local/reward-runs/`; do not paste raw JSON into normal handoffs.

Do not start provider fine-tuning. Export only reviewed, sanitized,
export-eligible reward records.
