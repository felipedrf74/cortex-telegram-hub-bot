# Backend Documentation Index

Status: canonical
Owner: backend architecture lead
Last verified: 2026-08-12
Update policy: update only when a canonical path changes

Start with `docs/project-map.json`; it provides structured module, route,
migration, capability, skill, test, asset, owner, and per-document governance
mapping. `config/documentation-policy.json` assigns active status, owner, and
review cadence through compact path rules plus explicit exceptions.

| Need | Canonical source |
| --- | --- |
| Continuous-deployment architecture and lifecycle | `docs/release/continuous-deployment.md` |
| VPS provisioning, bootstrap, recovery, and fallback operations | `../ops/nexus-release/README.md` |
| Signed continuous-release evidence contract | `docs/release/release-evidence-contract.md` |
| State-coupled migration owner and recovery contract | `docs/release/migration-irreversible.md` |
| PM2 first-cutover fallback (14 stable days only) | `docs/release/README.md` |
| Generated non-authoritative release projections | `docs/release/release-state.json`, `docs/release/CURRENT_RELEASE_STATE.md` |
| App Store submission and review configuration | `docs/release/app-store-submission-runbook.md` |
| Test tiers and dispositions | `config/test-policy.json` |
| Documentation status, ownership, and review | `config/documentation-policy.json` |
| Engineering standards | `docs/engineering/ENGINEERING_STANDARDS_INDEX.md` |
| Security controls and operations | `docs/security/security-control-matrix.md`, `docs/security/security-operations-runbook.md` |
| Threat model | `docs/security/nexus-security-threat-model.md` |
| Paid-AI and quota contract | `docs/TOKEN-QUOTA-CONTRACT.md` |
| Local-primary inference architecture and rollout | `docs/engineering/local-primary-inference-standard.md` |
| Reward verification | `docs/agents/VERIFIABLE_REWARD_PROTOCOL.md` |
| Legal and retention | `docs/legal/` |
| Local runtime | `docs/local-dev/README.md` |

Git history is the archive. Do not add historical reports, QA handoffs, smoke
evidence, task files, mirrors, or competing current verdicts to the tree.
