---
name: test-audit
description: Profile, select, consolidate, or govern Nexus Hub backend tests. Use for slow CI, large test-file or 13k-case suites, migration replay, flaky benchmarks, changed-test mapping, coverage, mutation checks, QA-suite duplication, or keep/merge/convert/eval/delete dispositions.
---

# Nexus Test Audit

Read `config/test-policy.json`, then generate current evidence:

```bash
npm run test:inventory
npm run test:migration-hook-lint
npm run test:profile
```

- Optimize repeated setup before deleting coverage.
- Keep changed dependency tests, critical tests, and cannot-skip risks as one de-duplicated union.
- Keep wall-clock benchmarks outside correctness CI.
- Require every discovered test to resolve to one disposition.
- Preserve distinct security, tenant, localization, routing, policy, migration, and public-contract coverage.
- Move subjective quality/persona/provider grading to `test:evaluate`.
- Store inventories and timings under `.local/`; do not create Markdown reports.

Use `scripts/risk-gate.sh` for verification. Cleanup must not reduce changed
module coverage or critical mutation protection without an owned, expiring
exception in the policy.
