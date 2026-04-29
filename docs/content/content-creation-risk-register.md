# Content Creation Risk Register

Date: 2026-04-29
Branch: `feature/content-creation-intelligence-upgrade`

| ID | Severity | Risk | Evidence | Mitigation |
|---|---:|---|---|---|
| CONTENT-R001 | P0 | Tenant-safe Content references are not proven | Content uses `user_id` and `owner_scope`, but not a full tenant-owned source model | Do not claim tenant-shared content intelligence until tenant_id/visibility contracts exist |
| CONTENT-R002 | P1 | Anthropic direct-call bypass in dedup | Found in audit; first implementation pass replaced it with `completeOneShotWithFallback()` and category `content_dedup` | CLOSED IN CODE; keep broader provider-routing regression gate |
| CONTENT-R003 | P1 | Internal content-engine AI proxy lacks tenant/user attribution | Audit found Python proxy sent prompt/system/category only | PARTIALLY CLOSED IN CODE: user metadata now flows for script generation; true tenant metadata remains open until active tenant id is available |
| CONTENT-R004 | P1 | `/content/discover` did not use route scope guard | Found in audit; first implementation pass added `content_route_discover` validation | CLOSED IN CODE |
| CONTENT-R005 | P1 | Reference/learning routes had uneven route-scope validation | Found in audit; first implementation pass added guard coverage to reference and learning routes | CLOSED IN CODE |
| CONTENT-R006 | P1 | Portal/admin content writes are global and id-based | `content-admin-write.ts`, `portal/content-routes.ts` | Keep founder/platform-only, audit access, or add tenant/user target policy |
| CONTENT-R007 | P1 | Id-only helper mutations can cross ownership if misused | Audit found `updateFeedback`, `markScriptGenerated`, `removeChannel`, `updateChannelStatus` | PARTIALLY CLOSED IN CODE for workflow feedback helpers; channel/admin helpers remain open |
| CONTENT-R008 | P1 | Content scheduling bypasses Secretary arbitration | `content-topic-secretary-sync.ts` calls task/calendar services directly | Introduce Content scheduling intents with backward-compatible sync fallback |
| CONTENT-R009 | P1 | Shared context is not full tenant mesh | Existing context docs say `agent_signals` lacks tenant_id | Use scoped summaries only; do not claim tenant-shared mesh |
| CONTENT-R010 | P1 | Source/provenance insufficient for serious content intelligence | No unified source registry for books/channels/links | Add source contract and provenance metadata |
| CONTENT-R011 | P1 | Skill version tracking missing | No first-class skill release ledger for all skills | Add skill version/capability/change/test/open-item registry |
| CONTENT-R012 | P2 | Static creator prompt and hardcoded niche buckets | `content-discovery.ts` loads static creator config and hardcoded buckets | Replace with creator profile and per-user/tenant content strategy |
| CONTENT-R013 | P2 | iOS cannot resolve specific Content notification target | `SkillsHubView.swift` documents missing notification resolver | Add notification resolver API and deep-link routing |
| CONTENT-R014 | P2 | iOS would flatten source/provenance/lifecycle states | Current DTOs focus on current pipeline/home/script/topic surfaces | Add DTO decoding/rendering for provenance and lifecycle states |
| CONTENT-R015 | P2 | Misleading model comments can cause future routing regressions | `content-script-routes.ts` says Claude Sonnet | Update comments when touching code; keep docs provider-agnostic |

## Immediate Security Posture

No active production exploit was proven in this audit. The known concern is broader: Content cannot yet prove full tenant-safe creative intelligence. Therefore release copy must avoid tenant-shared Content memory/reference claims until the data model, routes, portal surfaces, prompt construction, and tests close the gaps above.

## Routing Posture

Do not replace the live routing architecture with a fixed model. The direct Anthropic paths should be converted to existing provider-routing abstractions or documented as provider-specific capability paths with explicit gating, scope metadata, and tests.
