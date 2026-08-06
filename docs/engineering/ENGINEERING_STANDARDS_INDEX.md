# Backend Engineering Standards Index

Status: canonical
Owner: backend architecture lead
Last verified: 2026-07-17
Update policy: update when a new canonical engineering standard is
added under `docs/engineering/`. Removing a standard requires
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
| **Offline-first Tasks architecture** | `offline-first-tasks-architecture.md` | Any backend or iOS change to Tasks identity, sync state, mutation replay, provider mappings, or offline storage. |
| **GenAI migration plan** | `genai-migration-plan.md` | Any migration of provider calls, model routing, prompt ownership, or generated-content runtime behavior. |
| **JWT rotation runbook** | `jwt-rotation-runbook.md` | Any JWT signing-key rotation or authentication incident. |
| **Training exercise media operator runbook** | `training-exercise-media-v1-operator-runbook.md` | Any Training catalog package, approval, activation, media-origin, or rollback change. |
| **Training plan request semantics** | `training-plan-request-semantics.md` | Any change to `sessionsPerWeek` semantics or to `raceDate`/`goalMode` behaviour (F8/F12 contract + pending policy decision). |
| **Backend Verifiable Reward Protocol companion** | `../agents/VERIFIABLE_REWARD_PROTOCOL.md` | Any change to reward verdicts, reward-check orchestration, hooks, handoff summaries, or export behavior. |
| **Security threat model** | `../security/nexus-security-threat-model.md` | Any security scan, new deployed surface, new provider, new trust boundary, or incident review. |
| **Security control matrix** | `../security/security-control-matrix.md` | Any auth, API, iOS storage, WebSocket, provider, CI, infra, logging, backup, or incident-response hardening. |
| **Security operations runbook** | `../security/security-operations-runbook.md` | Any live infrastructure, backup, secret, incident, Cloudflare, VPS, or operator procedure change. |
| **Security hardening implementation status** | `../security/security-hardening-implementation-status.md` | Security wave closeout, blocked-item review, or hostile QA handoff. |

## Companion canonical docs

| Doc | Path | Purpose |
|---|---|---|
| Project map | `../project-map.json` | Generated module, route, migration, capability, skill, test, asset, owner, and canonical-doc map. |
| Release runbook | `../release/README.md` | Exact-artifact operator commands and production sequence. |
| Current release summary | `../release/CURRENT_RELEASE_STATE.md` | Compact human pointer to the machine-readable runtime truth. |
| Checksum release evidence contract | `../release/release-evidence-contract.md` | Artifact-bound protected-main/checkpoint, staging, promotion, and rollback evidence. |
| State-coupled migration contract | `../release/migration-irreversible.md` | Snapshot rollback and rehearsal gates for irreversible or state-coupled schema cutovers. |

## Related cross-repo standards

| Standard | Path | Purpose |
|---|---|---|
| iOS architecture + SwiftUI performance | `ios/docs/engineering/ios-architecture-and-swiftui-performance-standard.md` | iOS state ownership, observation, navigation, frame budget. |
| iOS frontend validation checklist | `ios/docs/engineering/ios-frontend-validation-checklist.md` | What "validated" means for iOS changes. |
| Agent process standard | `docs/agent/AGENT_PROCESS_STANDARD.md` | How Claude/Codex should operate in the workspace. |
| Nexus Verifiable Reward Loop | `docs/agent/VERIFIABLE_REWARD_PROTOCOL.md` | Workspace canonical reward protocol and calibration/enforcement policy. |

## Reading order for new agents

1. `docs/DOCS_INDEX.md` (workspace)
2. `docs/agent/OPERATING_CONTEXT.md`
3. `docs/agent/AGENT_PROCESS_STANDARD.md`
4. `docs/agent/AGENT_TECHNICAL_MASTERY.md` (cross-repo technical onboarding pack)
5. `docs/release/CURRENT_RELEASE_STATE.md`
6. `docs/release/OPEN_ITEMS.md`
7. `CLAUDE.md`
8. The standards relevant to the work area (this index).
