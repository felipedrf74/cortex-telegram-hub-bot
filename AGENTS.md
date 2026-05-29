# AGENTS.md - Nexus Hub Backend Agent Guardrails

Status: repo-local backend agent entrypoint
Owner: release gatekeeper role, default Felipe
Last verified: 2026-05-28

This repository uses the Delivered-Means-Verified workflow. Before editing,
verify the active Work Order, branch/worktree, owned paths, mode, and evidence
targets. When in doubt, update the Work Order before changing implementation
files.

## No Hardcoded Product Behavior

Do not fix Nexus Hub behavior by hardcoding a specific user, email, tenant,
task title, recipe, ingredient list, domain example, simulator fixture, provider,
or one-off phrase into runtime code. Runtime behavior must come from typed
contracts, deterministic parsers, configured flags/env, persisted data,
capability registries, model outputs validated by schemas, or explicit test
fixtures that cannot affect production.

If a bug appears to need a hardcoded special case, stop and design the generic
rule first. Acceptable literals are protocol constants, schema versions,
feature-flag names, localization keys, parser vocabularies, and test/corpus
fixtures clearly scoped outside runtime behavior.

## Verification

Run the lane checks when starting or reviewing work:

```bash
node scripts/verify-agent-lanes.mjs --registry docs/qa/AGENT_WORK_REGISTRY.md
node scripts/verify-agent-lanes.mjs --work-order docs/qa/work-orders/WO-ID.md
```

Backend proof cannot claim iOS behavior. iOS simulator proof cannot claim
backend production behavior. Production claims require the deployed
version/commit plus live health or smoke evidence.
