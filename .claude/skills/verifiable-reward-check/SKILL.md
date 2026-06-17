---
name: verifiable-reward-check
description: Run the Nexus Verifiable Reward Loop before ending non-trivial Claude Code backend work. Use when Felipe mentions rewards, RLVR-inspired checks, verifier-driven development, handoff quality, calibration, enforcement, reward summaries, or when a backend session produces code, docs, QA, research, release, or process deliverables.
---

# Verifiable Reward Check

Use `docs/agents/VERIFIABLE_REWARD_PROTOCOL.md` and the workspace canonical
policy at
`/Users/felipedominguez/Desktop/Nexus Hub/docs/agent/VERIFIABLE_REWARD_PROTOCOL.md`.

Run before final handoff/final answer for non-trivial work:

```bash
node scripts/reward-check.mjs --area auto --advisory
```

With a handoff:

```bash
node scripts/reward-check.mjs --area auto --handoff docs/agents/handoffs/<file>.md --advisory
```

Verdict and hard failures outrank score. Do not silently skip mandatory checks.
Keep raw reward JSON under `.local/reward-runs/`, summarize only the compact
verdict block in handoffs, and do not start provider fine-tuning.
