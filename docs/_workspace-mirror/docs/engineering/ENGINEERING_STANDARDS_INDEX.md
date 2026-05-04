# Workspace Engineering Standards Index

Status: canonical
Owner: workspace lead (Felipe)
Last verified: 2026-05-04
Update policy: update when a new cross-repo standard lands or when the
location of an existing standard changes.

This is the workspace-level routing map for engineering excellence
standards across both repos. Each repo also has its own engineering
standards index at:

- Backend: `engine/docs/engineering/ENGINEERING_STANDARDS_INDEX.md`
- iOS: `ios/docs/engineering/ENGINEERING_STANDARDS_INDEX.md`

Read this index first when starting an architecture, security, runtime,
testing, or release-process task.

## Cross-repo standards (workspace-level)

| Standard | Path | Scope |
|---|---|---|
| Agent process standard | `docs/agent/AGENT_PROCESS_STANDARD.md` | How Claude/Codex should operate; evidence levels; two-agent validation; canonical-docs rule. |
| Workspace operating context | `docs/agent/OPERATING_CONTEXT.md` | Workspace bootloader (must be read first). |
| Current release state | `docs/release/CURRENT_RELEASE_STATE.md` | Current production identity and validation. |
| Open items | `docs/release/OPEN_ITEMS.md` | P0/P1/P2/P3 items across the workspace. |

## Backend standards

| Standard | Path | When to read |
|---|---|---|
| Backend engineering index | `engine/docs/engineering/ENGINEERING_STANDARDS_INDEX.md` | Entry point for backend standards. |
| Backend API and contract | `engine/docs/engineering/backend-api-contract-standard.md` | Routes, services, DTOs, idempotency, migrations. |
| Security and data isolation | `engine/docs/engineering/security-and-data-isolation-standard.md` | Auth, tenant scope, prompt context, tool authorization. |
| Runtime and observability | `engine/docs/engineering/runtime-and-observability-standard.md` | Logs, traces, alerts, deploy/rollback. |
| Testing and QA harness | `engine/docs/engineering/testing-and-qa-harness-standard.md` | Test categories, evidence requirements, classifier. |

## iOS standards

| Standard | Path | When to read |
|---|---|---|
| iOS engineering index | `ios/docs/engineering/ENGINEERING_STANDARDS_INDEX.md` | Entry point for iOS standards. |
| iOS architecture + SwiftUI | `ios/docs/engineering/ios-architecture-and-swiftui-performance-standard.md` | State ownership, observation, navigation, frame budget. |
| iOS frontend validation | `ios/docs/engineering/ios-frontend-validation-checklist.md` | What "validated" means; E1–E5 evidence. |

## Companion (release-process, runbooks, on-call)

| Doc | Path | Purpose |
|---|---|---|
| Risk-based gate matrix | `engine/docs/release/risk-based-release-gate-matrix.md` | Maps changed-area to required tests/smokes. |
| Production promotion checklist | `engine/docs/release/production-promotion-checklist-v2.md` | Deploy runbook. |
| Closed-beta runbook | `engine/docs/release/closed-beta-runbook.md` | Closed-beta operator runbook. |
| Portal scope policy | `engine/docs/release/portal-scope-policy.md` | Portal admin/user scope rules. |
| Simulator and local-service hygiene | `engine/docs/release/simulator-and-local-service-hygiene.md` | Cleanup contract for local dev. |
| Observability / on-call | `engine/docs/OBSERVABILITY-ONCALL.md` | Alert lifecycle. |
| Codex deploy process brief | `docs/release/codex-deploy-process-brief.md` | Self-contained deploy operator prompt. |

## How standards relate

```
docs/agent/AGENT_PROCESS_STANDARD.md
  └─ governs HOW Claude/Codex work
     ├─ engine/docs/engineering/ (backend WHAT)
     │  ├─ backend-api-contract-standard.md
     │  ├─ security-and-data-isolation-standard.md
     │  ├─ runtime-and-observability-standard.md
     │  └─ testing-and-qa-harness-standard.md
     ├─ ios/docs/engineering/ (iOS WHAT)
     │  ├─ ios-architecture-and-swiftui-performance-standard.md
     │  └─ ios-frontend-validation-checklist.md
     └─ engine/docs/release/risk-based-release-gate-matrix.md
        (maps WHAT changed → which tests run)
```

## Reading order when starting a task

1. `docs/DOCS_INDEX.md` (workspace map).
2. `docs/agent/OPERATING_CONTEXT.md`.
3. `docs/agent/AGENT_PROCESS_STANDARD.md`.
4. `docs/release/CURRENT_RELEASE_STATE.md`.
5. `docs/release/OPEN_ITEMS.md`.
6. The repo-local `CLAUDE.md` for the area you'll touch.
7. **The engineering standard(s) for the work area** (this index).
8. The risk-based gate matrix if the work is release-track.

## Workspace docs durability (ENG-EXC-O8 closure)

The workspace `docs/` folder is NOT a git repo per the existing
convention. To keep workspace-level canonical docs durable across
careless `rm`s and accidental rewrites, a one-way mirror at
`engine/docs/_workspace-mirror/` snapshots the workspace into the
engine repo. Workspace remains the source of truth; the mirror travels
with engine commits.

- **Source**: `<workspaceRoot>/{CLAUDE.md, AGENTS.md, README.md,
  docs/**/*.md, docs/release/release-identity.json}`. `docs/archive/`
  is intentionally NOT mirrored (it's already historical evidence).
- **Mirror**: `engine/docs/_workspace-mirror/`.
- **Refresh**: `engine/scripts/workspace-docs-mirror.sh`.
- **Check**: `engine/scripts/workspace-docs-mirror.sh --check`
  (exit 1 on drift).
- **Automatic refresh**: weekly housekeeping
  (`engine/.github/workflows/weekly-housekeeping.yml`). Manual
  refresh after editing any workspace doc is recommended.
- **Drift surfacing**: `engine/scripts/audit-docs.mjs` adds a
  `workspace-mirror-stale` warning when a workspace doc is newer than
  its mirror, OR `workspace-mirror-missing` when the mirror has no
  copy of a workspace doc.

The mirror is auditor-aware: `audit-docs.mjs` skips the mirror itself
from per-file lints (it would otherwise duplicate every warning), but
flags drift as a single workspace-level warning.

## Standard authoring rules

When adding a new engineering standard:

1. **Place it in the right repo.** Backend goes to
   `engine/docs/engineering/`; iOS goes to `ios/docs/engineering/`;
   cross-repo goes to `docs/engineering/`.
2. **Register it in the corresponding index** AND in this workspace
   index AND in `docs/DOCS_INDEX.md`.
3. **Use the standard frontmatter** (status / owner / last verified /
   update policy). The `audit-docs.mjs` enforces this for
   `engineering/` paths and the agent process standard.
4. **Use "must" / "should" / "may" precisely** per RFC-2119 conventions.
5. **Each "must" is a release gate.** If it can't be enforced, it's a
   "should". Don't dilute "must" by overusing it.
6. **Cite the failure mode** the standard prevents. A standard without a
   linked past-failure is a guess.
7. **If the standard lives at workspace level** (not in `engine/` or
   `ios/`), refresh the workspace-docs mirror via
   `engine/scripts/workspace-docs-mirror.sh` so the standard travels
   with the next engine commit.
