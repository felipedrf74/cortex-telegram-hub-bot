# Backend Engineering Standards Index

Status: canonical
Owner: backend architecture lead
Last verified: 2026-09-04
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
| **Runtime, observability, ops** | `runtime-and-observability-standard.md` | Any change to logging, alerts, health checks, container deployment/rollback, or the temporary PM2 fallback model. |
| **Testing and QA harness** | `testing-and-qa-harness-standard.md` | Any test addition, classifier change, smoke script change, or evidence-claim review. |
| **Offline-first Tasks architecture** | `offline-first-tasks-architecture.md` | Any backend or iOS change to Tasks identity, sync state, mutation replay, provider mappings, or offline storage. |
| **Scalability and optimistic mutation roadmap** | `scalability-and-optimistic-mutation-roadmap.md` | Any write route, mutation contract, outbox/delta-sync, cache, scheduler fan-out, WebSocket/APNs, provider client, retention, process-topology, or iOS optimistic-rendering change; any Redis/Postgres/replica proposal. |
| **GenAI migration plan** | `genai-migration-plan.md` | Any migration of provider calls, model routing, prompt ownership, or generated-content runtime behavior. |
| **Local-primary inference** | `local-primary-inference-standard.md` | Any local model, specialist profile, gateway, inference scheduler, fallback, script-job, bakeoff, or local pricing-gate change. |
| **JWT rotation runbook** | `jwt-rotation-runbook.md` | Any JWT signing-key rotation or authentication incident. |
| **Training exercise media operator runbook** | `training-exercise-media-v1-operator-runbook.md` | Any Training catalog package, approval, activation, media-origin, or rollback change. |
| **Training plan request semantics** | `training-plan-request-semantics.md` | Any change to `sessionsPerWeek` semantics or to `raceDate`/`goalMode` behaviour (F8/F12 contract + pending policy decision). |
| **Backend Verifiable Reward Protocol** | `../agents/VERIFIABLE_REWARD_PROTOCOL.md` | Any change to reward verdicts, reward-check orchestration, hooks, handoff summaries, or export behavior. |
| **Security threat model** | `../security/nexus-security-threat-model.md` | Any security scan, new deployed surface, new provider, new trust boundary, or incident review. |
| **Security control matrix** | `../security/security-control-matrix.md` | Any auth, API, iOS storage, WebSocket, provider, CI, infra, logging, backup, or incident-response hardening. |
| **Security operations runbook** | `../security/security-operations-runbook.md` | Any live infrastructure, backup, secret, incident, Cloudflare, VPS, or operator procedure change. |
| **Security hardening implementation status** | `../security/security-hardening-implementation-status.md` | Security wave closeout, blocked-item review, or hostile QA handoff. |

## Companion canonical docs

| Doc | Path | Purpose |
|---|---|---|
| Project map | `../project-map.json` | Generated module, route, migration, capability, skill, test, asset, owner, and canonical-doc map. |
| Continuous deployment | `../release/continuous-deployment.md` | Canonical recovery-first architecture, signed release lifecycle, migration admission, rollback, and evidence semantics. |
| VPS release operations | `../../ops/nexus-release/README.md` | Provisioning, bootstrap, recovery, timer control, and exact first-cutover fallback procedures. |
| Continuous-release evidence contract | `../release/release-evidence-contract.md` | Signed OCI payload, immutable state/receipt, staging, production observation, recovery, and rollback evidence. |
| State-coupled migration contract | `../release/migration-irreversible.md` | Owner-approved quiescence, snapshot, rehearsal, and database-plus-runtime recovery contract for destructive or state-coupled schema cutovers. |
| PM2 first-cutover fallback | `../release/README.md` | Exact-artifact fallback path retained only for the first 14 stable container days. |
| Generated release summary | `../release/CURRENT_RELEASE_STATE.md` | Non-authoritative checked-in projection; live host state and immutable receipts are authoritative. |

## Related cross-repo standards

Use [shared development policy](../agents/DEVELOPMENT_PROCESS.md) for planning,
ownership, evidence reuse and closeout. Start from AGENTS.md; load only the
standards relevant to the changed area. A cloud agent needs no home-directory
workspace checkout to follow this process.

For native work, read the iOS repository's AGENTS.md and its engineering index.
Use the canonical backend OpenAPI contract for cross-repository API changes.
