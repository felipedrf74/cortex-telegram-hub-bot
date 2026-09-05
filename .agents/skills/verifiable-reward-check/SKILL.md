---
name: verifiable-reward-check
description: Run the Nexus Verifiable Reward Loop before ending non-trivial backend implementation. Use when Felipe mentions rewards, RLVR-inspired checks, verifier-driven development, handoff quality, calibration, enforcement, reward summaries, or when a backend session produces code, docs, QA, research, release, or process deliverables.
---

# Verifiable Reward Check

Use the canonical backend policy at
`docs/agents/VERIFIABLE_REWARD_PROTOCOL.md`.

Run before final implementation closeout. Planning/read-only answers use
source review; do not create a handoff or run artifacts just for a score:

```bash
node scripts/reward-check.mjs --area auto --advisory
```

Interpret verdicts before scores:

- `FAIL`: fix or report a blocker.
- `MANUAL_REQUIRED`: name the missing human/device/staging/provider evidence.
- `WARN`: hand off with caveats if mandatory gates are satisfied.
- `PASS`: required evidence exists and mandatory checks passed.
- `NOT_APPLICABLE`: no meaningful reward check applies.

Document skipped checks as acceptable skip, warning, manual review required, or
hard failure. Keep raw JSON under `.local/reward-runs/`; put the compact summary
in the response or the canonical current release state, not a new handoff file.

Do not start provider fine-tuning. Export only reviewed, sanitized,
export-eligible reward records.
