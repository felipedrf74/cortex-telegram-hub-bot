# Backend Documentation Index

Status: canonical
Owner: backend architecture lead (Felipe)
Last verified: 2026-07-10
Update policy: update when a new canonical backend doc location is added
or a canonical path moves. The workspace-level entry point is
`docs/DOCS_INDEX.md`.

This is the backend repo's markdown routing map for Codex and Claude Code.

## Current Docs To Update

| Purpose | Status | Path | Update Policy |
| --- | --- | --- | --- |
| Backend QA status | current | `docs/qa/QA_BACKEND_REPORT.md` | Update after backend QA, security, runtime, or release validation. |
| Backend Verifiable Reward Protocol companion | canonical | `docs/agents/VERIFIABLE_REWARD_PROTOCOL.md` | Update when backend-local reward commands, schema, hooks, or export behavior change. |
| Reward run schema | canonical | `docs/agents/reward-run-schema.json` | Update when `scripts/reward-check.mjs` output shape changes. |
| Release process entrypoint | canonical | `docs/release/README.md` | Keep as the release-process start page. |
| Current release index | current | `docs/release/current-release-index.md` | Update first for active release decisions and exact RC identity. |
| Production checklist | canonical | `docs/release/production-promotion-checklist-v2.md` | Update only when the process changes. |
| Risk-based gate matrix | canonical | `docs/release/risk-based-release-gate-matrix.md` | Update when changed-file gating changes. |
| Engineering standards index | canonical | `docs/engineering/ENGINEERING_STANDARDS_INDEX.md` | Update when a new backend engineering standard is added. |
| Backend API contract standard | canonical | `docs/engineering/backend-api-contract-standard.md` | Update when REST contract conventions change. |
| Paid AI entitlement and quota contract | canonical | `docs/TOKEN-QUOTA-CONTRACT.md` | Update when model eligibility, daily/monthly/automation limits, Nexus Points rules, stable errors, or provider-call attribution changes. |
| Security and data isolation standard | canonical | `docs/engineering/security-and-data-isolation-standard.md` | Update when threat model or permanent gates change. |
| Nexus security threat model | canonical | `docs/security/nexus-security-threat-model.md` | Update when deployed surfaces, trust boundaries, or attacker-controlled inputs change. |
| Security control matrix | canonical | `docs/security/security-control-matrix.md` | Update when route families, mobile storage, providers, or release security gates change. |
| Security operations runbook | canonical | `docs/security/security-operations-runbook.md` | Update after infrastructure, backup, incident response, or secret-rotation process changes. |
| Security hardening implementation status | current | `docs/security/security-hardening-implementation-status.md` | Update after each hardening wave or QA finding closure. |
| Security hardening Claude QA prompt | current handoff | `docs/security/security-hardening-claude-qa-prompt.md` | Update when the hardening review scope or evidence changes. |
| Content references scope audit | current | `docs/security/content-references-scope-audit.md` | Update when `src/state/content-references.ts` owner-scope, admin-gating, or prompt-reference semantics change. |
| iOS JWT rotation runbook | canonical | `docs/engineering/jwt-rotation-runbook.md` | Update when iOS JWT signing or verification semantics change. |
| Google GenAI migration plan | canonical | `docs/engineering/genai-migration-plan.md` | Update when a Google SDK migration phase lands or the SDK API surface changes. |
| Runtime and observability standard | canonical | `docs/engineering/runtime-and-observability-standard.md` | Update when health/log/alert semantics change. |
| Testing and QA harness standard | canonical | `docs/engineering/testing-and-qa-harness-standard.md` | Update when test categories or evidence requirements change. |
| Offline-first Tasks architecture | canonical | `docs/engineering/offline-first-tasks-architecture.md` | Update when Tasks identity, sync state, mutation replay, provider mappings, or iOS offline storage contracts change. |
| Notification Center boundary | canonical | `docs/notifications/notification-center-boundary.md` | Update when user notifications, operator alerts, badges, or legacy delivery boundaries change. |
| Privacy policy draft | lawyer-review | `docs/legal/privacy-policy-draft.md` | Owner/counsel must approve before publication. |
| Terms of service draft | lawyer-review | `docs/legal/terms-of-service-draft.md` | Owner/counsel must approve before publication. |
| Content Agency model | current | `docs/content/content-agency-model.md` | Update when creator-agency rules, routes, persistence, iOS behavior, or quality gates change. |
| Docs drift audit | canonical command | `npm run docs:audit` | Run before creating release docs or copying verdicts/test counts. |

## Historical Docs

Historical one-off reports belong under:

```text
docs/release/archive/
docs/archive/
```

Do not treat old timestamped reports as current truth unless
`docs/release/current-release-index.md` links them explicitly.

## Agent Rules

1. Before creating a new markdown report, update the current doc above when
   one matches the work.
2. If a new report is unavoidable, link it from the current index.
3. Do not duplicate final verdicts across multiple current files.
4. Keep commit hashes and test counts in the current release index, not copied
   into many workstream docs.
5. Never delete historical evidence until it has been archived or explicitly
   classified as scratch.
6. Use `/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot`
   as the backend workspace entrypoint. Use the iOS workspace only for native
   iOS work. Do not start from old beta-agent folders.
