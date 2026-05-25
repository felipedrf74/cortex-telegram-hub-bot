# Codex Handoff

## Current Cross-Agent Truth - 2026-04-25

This section supersedes older branch/status notes below. Historical handoff
content is retained only for provenance.

- Current beta branch: `beta/single-agent-rc`.
- iOS beta worktree:
  `/Users/felipedominguez/Desktop/Nexus Hub IOS/beta-codex-single-agent`.
- Backend beta worktree:
  `/Users/felipedominguez/Desktop/Custom Connectors/Cortex/beta-codex-single-agent`.
- Backend production is live at `4.14.64`.
- Founder accounts verified in production:
  `felipedrf74@gmail.com` and `vieira.jaqueline@gmail.com`.
- Backend full verification passed: 342 test files / 5,436 tests.
- Hardened staging operator-session smoke passed valid, expired, tampered,
  unauthorized role/scope, wrong-tenant, and static-token rejection paths.
- External webhook/on-call staging drill passed alert creation, delivery,
  acknowledgement, resolution, and audit verification.
- iOS simulator smoke with Felipe's persisted account covered Home,
  Connections, Skills, Training, Chat, and Tasks against the promoted backend.
- Remaining release gates are signed TestFlight/device proof, APNs token and
  delivery proof, fresh auth/onboarding, true two-account switching, and real
  Gmail/Outlook/Health provider-state checks.

Do not treat the older `codex/ios-ml-architecture-pass` notes below as current
release status.

Last updated: 2026-04-21

## Current branch
- iOS checkout branch: `codex/ios-ml-architecture-pass`

## Current mission
- Workstream: iOS ML architecture review and bounded implementation
- Status:
  - overlap audit completed
  - hybrid recommendation documented
  - iOS-side deterministic helper layer implemented
  - EN/PT eval corpus expanded
  - focused tests passed
  - build passed

## Chosen architecture
- **Hybrid wins**
- iOS owns:
  - low-latency deterministic helpers
  - one-turn clarification for bounded intents
  - local safety pre-checks for deterministic writes
  - local provenance metadata
  - lightweight memory hints
  - routing telemetry
- TypeScript Engine remains owner of:
  - ambiguous routing
  - provider/model routing
  - deep response generation
  - tool loops
  - shared grounding
  - persistent memory
  - Secretary orchestration
  - coach planning and guardrails
  - cross-skill tradeoff decisions

## What landed in code
- New feature-flagged ML modules:
  - `/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub/Nexus Hub/Core/ML/MLFeatureFlags.swift`
  - `/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub/Nexus Hub/Core/ML/ReasoningOrchestrator.swift`
  - `/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub/Nexus Hub/Core/ML/ClarificationPolicy.swift`
  - `/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub/Nexus Hub/Core/ML/SafetyPolicy.swift`
  - `/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub/Nexus Hub/Core/ML/GroundedResponseBuilder.swift`
  - `/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub/Nexus Hub/Core/ML/MemoryRetriever.swift`
- Integration updates:
  - `/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub/Nexus Hub/Core/AppState.swift`
  - `/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub/Nexus Hub/ViewModels/ChatViewModel.swift`
  - `/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub/Nexus Hub/Core/Repositories/ChatRepository.swift`
  - `/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub/Nexus Hub/Core/ML/RoutingMetrics.swift`
  - `/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub/Nexus Hub/Core/ML/LocalCommandHandler.swift`
  - `/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub/Nexus Hub/Models/Message.swift`

## Validation truth
- Focused ML + fastpath tests:
  - passed
- iOS simulator build:
  - passed
- What is still unverified:
  - broader end-to-end runtime behavior beyond the targeted ML suite
  - production telemetry for latency/correction-rate gains

## Docs created/updated for this pass
- `/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub/docs/agents/codex/ios-ml-architecture-log.md`
- `/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub/docs/agents/codex/ios-ml-architecture-backlog.md`
- `/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub/docs/architecture/ios-vs-ts-responsibility-matrix.md`
- `/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub/docs/architecture/ios-ml-architecture-recommendation.md`
- this handoff

## Highest-priority remaining work
1. Add lightweight inspection/export for routing metrics in debug builds.
2. Expand clarification coverage only where deterministic tests prove local
   ownership is safe.
3. Validate the new hybrid layer against broader runtime chat flows beyond the
   focused ML suite.

## Capabilities that must stay TS-owned
- authoritative ambiguous routing
- model/provider routing
- deep response generation
- tool execution loops
- shared decision context / full grounding
- persistent long-term memory
- Secretary orchestration and focus planning
- coach planning and guardrails
- cross-skill orchestration and tradeoff decisions

## Ready-for-review assessment
- Ready for review:
  - Yes, as a bounded iOS ML architecture pass.
- Ready to claim Apple ML-first migration:
  - No.
- Reason:
  - the evidence does not support Apple ML-first. Hybrid is the right split and
    deep reasoning must remain backend-owned.
