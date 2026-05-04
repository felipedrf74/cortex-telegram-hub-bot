# Backend Engineering Standards Index

Status: canonical
Owner: backend architecture lead
Last verified: 2026-05-04
Update policy: update when a new canonical engineering standard is
added under `engine/docs/engineering/`. Removing a standard requires
owner approval and a documented replacement.

This index is the entry point for backend engineering standards in
Nexus Hub. Every Claude Code or Codex run that touches backend code
should read the relevant standard from this list before making
non-trivial changes.

## Canonical standards

| Standard | Path | When to read |
|---|---|---|
| **Backend API and contract** | `backend-api-contract-standard.md` | Any change to `src/api/routes/`, `src/services/`, `src/state/`, or migrations. |
| **Security and data isolation** | `security-and-data-isolation-standard.md` | Any change to auth, session, tenant scope, prompt context, memory, tool call authorization, or audit logging. |
| **Runtime, observability, ops** | `runtime-and-observability-standard.md` | Any change to logging, alerts, health checks, deploy/rollback scripts, or PM2 process model. |
| **Testing and QA harness** | `testing-and-qa-harness-standard.md` | Any test addition, classifier change, smoke script change, or evidence-claim review. |

## Companion canonical docs

| Doc | Path | Purpose |
|---|---|---|
| Risk-based release gate matrix | `engine/docs/release/risk-based-release-gate-matrix.md` | Maps changed-area to required tests/smokes. |
| Production promotion checklist | `engine/docs/release/production-promotion-checklist-v2.md` | The deploy runbook. |
| Closed-beta runbook | `engine/docs/release/closed-beta-runbook.md` | Closed-beta operator runbook. |
| Portal scope policy | `engine/docs/release/portal-scope-policy.md` | Portal admin/user scope. |
| Observability / on-call | `engine/docs/OBSERVABILITY-ONCALL.md` | Alert lifecycle. |
| Skill architecture | `engine/docs/SKILL_ARCHITECTURE.md` | Skill catalog + sub-skill dependencies. |
| iOS integration | `engine/docs/IOS-INTEGRATION.md` | Backend ↔ iOS contract overview. |
| Model review process | `engine/docs/MODEL-REVIEW-PROCESS.md` | Model routing decisions. |

## Related cross-repo standards

| Standard | Path | Purpose |
|---|---|---|
| iOS architecture + SwiftUI performance | `ios/docs/engineering/ios-architecture-and-swiftui-performance-standard.md` | iOS state ownership, observation, navigation, frame budget. |
| iOS frontend validation checklist | `ios/docs/engineering/ios-frontend-validation-checklist.md` | What "validated" means for iOS changes. |
| Agent process standard | `docs/agent/AGENT_PROCESS_STANDARD.md` | How Claude/Codex should operate in the workspace. |

## Reading order for new agents

1. `docs/DOCS_INDEX.md` (workspace)
2. `docs/agent/OPERATING_CONTEXT.md`
3. `docs/agent/AGENT_PROCESS_STANDARD.md`
4. `docs/agent/AGENT_TECHNICAL_MASTERY.md` (cross-repo technical onboarding pack)
5. `docs/release/CURRENT_RELEASE_STATE.md`
6. `docs/release/OPEN_ITEMS.md`
7. `engine/CLAUDE.md`
8. The standards relevant to the work area (this index).
