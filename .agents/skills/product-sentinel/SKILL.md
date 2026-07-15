---
name: product-sentinel
description: Audit Nexus Hub product capabilities, scheduled agents, and governed learning. Use for capability or entitlement drift, scheduler ownership, unchanged-input provider calls, agent signal provenance, LearningCase promotion, registry parity, lifecycle state, cost or latency budgets, and stale product-learning evidence.
---

# Nexus Product Sentinel

Use generated project and runtime manifests before opening broad source trees:

```bash
npm run project:map
npm run manifests:validate
```

- Require lifecycle, owner, schema, memory scope, provider policy, channels,
  evaluations, and budgets for each capability.
- Require tenant scope, lock, retry, fingerprint, audit, validation, and
  notification policy for each scheduled job.
- Treat unchanged input as zero provider calls.
- Keep AI-produced signals provisional until supported by feedback, measured
  outcome, trusted evidence, or human approval.
- Keep `LearningCase` inputs redacted and tenant-safe. Never store raw calendar
  or private content, mutate prompts automatically, or initiate provider-side training.
- Remove duplicate maps only after generated parity tests pass.
