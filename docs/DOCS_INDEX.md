# Backend Documentation Index

Status: canonical
Owner: backend architecture lead
Last verified: 2026-07-17
Update policy: update only when a canonical path changes

Start with `docs/project-map.json`; it provides structured module, route,
migration, capability, skill, test, asset, owner, and per-document governance
mapping. `config/documentation-policy.json` assigns active status, owner, and
review cadence through compact path rules plus explicit exceptions.

| Need | Canonical source |
| --- | --- |
| Current production and TestFlight truth | `docs/release/release-state.json` |
| Human release summary and operator commands | `docs/release/CURRENT_RELEASE_STATE.md`, `docs/release/README.md` |
| Compact checksum release contract | `docs/release/release-evidence-contract.md` |
| State-coupled migration release contract | `docs/release/migration-irreversible.md` |
| App Store submission and review configuration | `docs/release/app-store-submission-runbook.md` |
| Test tiers and dispositions | `config/test-policy.json` |
| Documentation status, ownership, and review | `config/documentation-policy.json` |
| Engineering standards | `docs/engineering/ENGINEERING_STANDARDS_INDEX.md` |
| Security controls and operations | `docs/security/security-control-matrix.md`, `docs/security/security-operations-runbook.md` |
| Threat model | `docs/security/nexus-security-threat-model.md` |
| Paid-AI and quota contract | `docs/TOKEN-QUOTA-CONTRACT.md` |
| Reward verification | `docs/agents/VERIFIABLE_REWARD_PROTOCOL.md` |
| Legal and retention | `docs/legal/` |
| Local runtime | `docs/local-dev/README.md` |

Git history is the archive. Do not add historical reports, QA handoffs, smoke
evidence, task files, mirrors, or competing current verdicts to the tree.
