# ChatV2 Route-Exit Inventory

Status: initial inventory for `src/api/routes/chat-message-routes.ts`. This is the control sheet for Phase 7 legacy natural-language retirement. Route IDs are evidence labels, not runtime switches. Do not remove a row until it has independent parity >= 95% over >= 50 held-out rows, zero `chatv2_worse` safety regressions, tests, and a rehearsed rollback.

| Route Exit | Current Owner | Can Answer | Can Execute | External Effect | Keep Pre-ChatV2? | Planned ChatV2 Replacement | Disable/Control |
|---|---|---:|---:|---:|---:|---|---|
| Idempotent replay (`findCompletedAssistantForClientMessage`) | chat history store | yes | no | no | yes | unchanged idempotency shell | client message id |
| In-flight idempotency duplicate | chat route | yes | no | no | yes | unchanged idempotency shell | client message id |
| Token-zero message shortcuts | `chat-message-shortcuts.ts` | yes | no | no | yes for explicit commands | explicit token-zero surfaces only | bypassed for NL write intent |
| Quota exceeded | cost guardrail | yes | no | no | yes | unchanged quota shell | cost guardrail |
| General action planner | `chat-action-planner.ts` | yes | preview/confirm | possible after confirm | transitional | ChatV2 command preview/write gateway | action planner result status |
| Cached deterministic command | chat command cache | yes | no | no | yes for explicit commands | explicit token-zero cache | cacheable command list |
| Attachment response | attachment route | yes | no | no | yes | future ChatV2 attachment adapter | attachment presence |
| Authenticated identity fast path | auth/session services | yes | no | no | yes | deterministic identity adapter | identity detector |
| Deterministic slash fast path | `chat-fastpath.ts` | yes | no | no | yes | ChatV2 deterministic read adapter; explicit surfaces preserved | slash command parser |
| Chat reasoning engine v1 | `chat-reasoning-engine` | yes | task create/subtasks | native task write | transitional | ChatV2 Class A preview/confirmed write path | action frame status |
| Training plan shortcut | local response shortcut | yes | preview/open surface | no | transitional | ChatV2 training preview/open-surface response | phrase detector |
| Selective internet research | research router | yes | no | web fetch | no | ChatV2 read/answer planner + evidence policy | `CHAT_RESEARCH_ROUTER` |
| Decision confirmation shortcut | Decision Center | yes | confirmed action | possible | yes | ChatV2 confirmation/action gateway adapter | pending confirmation |
| Destructive confirmation hold | skill orchestrator | yes | preview only | no | transitional | ChatV2 write-intent firewall clarification/preview | safety requires confirmation |
| Classifier route + skill orchestration | router + skill orchestrator | yes | no direct | no | no | ChatV2 planner route decision | legacy classifier |
| Chat message shortcut after route | `chat-message-shortcuts.ts` | yes | no | no | transitional | ChatV2 deterministic read adapter | shortcut result |
| Domain handler execution | domain handlers | yes | tool-gated | possible through tools | no for ordinary NL | domain adapters + command bus | domain handler owner |
| Final response envelope/cache/persist | chat route | yes | no | no | yes as transport shell | ChatV2 response adapter | response contract |

## Retirement Rule

For each row marked transitional/no:
1. Gather held-out paired legacy-vs-ChatV2 observations with HMAC sample IDs only. Runtime-route runs must record the seeded-state `fixtureHash`, frozen corpus hash, comparator version, and review rubric version.
2. Have Claude/manual review the ephemeral raw local pairs, verify the artifact is complete against the manifest (`observationRows`, route IDs, HMAC IDs, `observationsSha256`, corpus hash, and fixture hash), and sign the report.
3. Import only safe aggregate labels with `evaluator=claude|manual`, a SHA-256 `peerReviewSignoffHash`, `safetyRegressionCount=0`, `qualityRegressionCount=0`, `degradedNotComparableCount=0`, `sampleCount >= 50`, and parity >= 95%.
4. Add focused tests for replacement behavior, response/action-card contract, locale, success-claim guard, tenant isolation, and rollback.
5. Roll out with the real runtime levers: `CHAT_CORE_V2_ORCHESTRATOR_MODE=canary|on`, `CHAT_CORE_V2_ALLOWED_DOMAINS`, per-tenant `allowedDomains`, and for write routes `CHAT_CORE_V2_ACTION_GATEWAY_MODE=enforce` plus `CHAT_CORE_V2_LEGACY_WRITE_FALLTHROUGH_BLOCK=on`.
6. Flip per-tenant `legacyFallbackDisabled=true` only as the final catch-all retirement step after attributed fallback monitors, degraded-response monitors, and rollback rehearsal pass.
7. Monitor 24h legacy fallback rate < 2%, confirmation/action error rate <= 1%, degraded response rate <= 3% (or <= 2x baseline), and raw/private leak count = 0.

Write-route note: `general_action_planner`, `chat_reasoning_engine_v1`, `decision_confirmation_shortcut`, and `destructive_confirmation_hold` are evidence rows, but they do not have independent runtime switches. They retire as a coupled write-firewall bundle only when `CHAT_CORE_V2_ACTION_GATEWAY_MODE=enforce` and `CHAT_CORE_V2_LEGACY_WRITE_FALLTHROUGH_BLOCK=on` are safe for the tenant/domain cohort.

Research-route note: `selective_internet_research` must use a safe public web-query packet. Raw Nexus local context, account/task/calendar/finance/health/email content, and raw recent turns must not be sent to web-search providers. Mutual degraded responses do not count as parity. Answer-quality research retirement evidence must use the current corpus, `chat_v2_legacy_parity_route_prompts@1.4.0` or newer, with at least 50 distinct public-query prompts; repeated-prompt padding and health-only corpora are invalid.

Target-route readiness note (2026-06-02): `classifier_route_skill_orchestration`
and `domain_handler_execution` now have explicit evidence-readiness metadata in
`src/services/chat-legacy-parity-route-prompts.ts` under
`CHAT_V2_PHASE7_TARGET_ROUTE_READINESS`. This metadata is not a runtime switch
and does not mark either route replaceable. It records the current blockers:
classifier evidence still needs deterministic-read vs local-chat/classifier
owner review, signed recall@8 thresholds by language, and reviewed labels for
the newly covered read/write collision and low-confidence clarification cases;
domain-handler evidence still needs per-domain signed parity floors in
cooking/content/training/finance/secretary order. Cooking replacement evidence
must remain generic and cannot rely on hardcoded recipes, dishes, ingredients,
or user-specific examples.

Held-out corpus status (2026-06-02): `chat_v2_legacy_parity_route_prompts@1.4.0`
has at least 50 distinct prompts for every Phase 7 retirement route:
`general_action_planner` 50, `chat_reasoning_engine_v1` 50,
`training_plan_shortcut` 65, `selective_internet_research` 52,
`decision_confirmation_shortcut` 50, `destructive_confirmation_hold` 50,
`classifier_route_skill_orchestration` 50,
`chat_message_shortcut_after_route` 53, and `domain_handler_execution` 50.
This is corpus readiness only. It does not import labels, does not hardcode
runtime behavior, and does not claim any route is replaceable.

Write-firewall corpus status (2026-06-02): the coupled write-route evidence
bundle now has distinct held-out prompts for `general_action_planner`,
`chat_reasoning_engine_v1`, `decision_confirmation_shortcut`, and
`destructive_confirmation_hold`, with the route-prompt tests verifying that
non-negated/non-hypothetical write prompts still trip the existing ChatV2 write
intent guard. These routes remain blocked together until distinct-endpoint
runtime observations are collected with isolated seeded users, Claude/manual
review signs HMAC-only labels, and the tenant/domain cohort can safely enforce
`CHAT_CORE_V2_ACTION_GATEWAY_MODE=enforce` plus
`CHAT_CORE_V2_LEGACY_WRITE_FALLTHROUGH_BLOCK=on`.

Classifier/domain-handler corpus status (2026-06-02): classifier prompts now
include local-chat cooking ownership, deterministic-read collisions,
low-confidence clarification probes, and content/training/finance/secretary
boundary prompts. Domain-handler prompts now cover cooking, content, training,
finance, and secretary at route level. Both routes remain blocked until signed
evidence proves the expected owner/outcome and each domain handler has its own
>=50-row, >=95% parity package with zero safety, quality, and
degraded-not-comparable regressions.

Historical blocked research-route evidence status (2026-06-02): a non-degraded distinct-endpoint
OpenAI-backed v1.2 observation package exists at
`.local/chatv2-parity/run-20260602T113745Z-research-v12-openai/observations-runtime-research-v12-openai-budget-override-50.ndjson`
with manifest `observationsSha256=5604f93fb3ecf286f1740b7d2a6e657b26df22b3a59af2a9cfa49645dd7b0056`.
Claude reviewed that package and blocked it at 46 / 50 quality parity because
some Spanish/es-419 prompts drifted into Portuguese and two answers were thinner
or weaker on source quality than legacy. The code now has generic turn-contract
Spanish research detection plus output-language and source-quality hardening, but
the route remains blocked until a fresh post-fix distinct-endpoint run is
reviewed and signed with zero safety, quality, and degraded-not-comparable
counts. A post-fix Gemini attempt under
`.local/chatv2-parity/run-20260602T121822Z-research-v12-locale-source-fix-gemini`
hit provider 503s and produced no observation artifact.

Historical blocked research-route evidence status (2026-06-02): a post-fix Gemini
retry/backoff distinct-endpoint v1.2 observation package exists at
`.local/chatv2-parity/run-20260602T161650Z-research-v15-backoff-gemini/observations-runtime-research-v15-backoff-gemini-50.ndjson`
with manifest
`.local/chatv2-parity/run-20260602T161650Z-research-v15-backoff-gemini/observations-runtime-research-v15-backoff-gemini-50.manifest.json`
and local raw-pair review artifact
`.local/chatv2-parity/run-20260602T161650Z-research-v15-backoff-gemini/observations-runtime-research-v15-backoff-gemini-50.review.json`.
Result: 50 / 50 runtime-tool matches, 0 route misses, 0
`degraded_not_comparable` rows, `distinctPromptsByRoute.selective_internet_research=52`,
and `observationsSha256=5604f93fb3ecf286f1740b7d2a6e657b26df22b3a59af2a9cfa49645dd7b0056`.
Claude QA reviewed the local raw pairs and blocked the package because roughly 9
ChatV2 answers were truncated or incomplete. The runtime 50 / 50 result is
therefore non-signable and must not be imported as retirement proof. No route is
retired by this package. The next valid evidence step is a fresh
post-truncation-fix distinct-endpoint run using
`chat_v2_legacy_parity_route_prompts@1.4.0` or newer, followed by
Claude/manual raw-pair review and signed HMAC-only labels with zero safety,
quality, and degraded-not-comparable counts.

Independent read-route corpus status (2026-06-02): `chat_v2_legacy_parity_route_prompts@1.4.0`
now has enough distinct scoped prompts to collect >=50 held-out rows without
prompt repetition for `training_plan_shortcut` (65 distinct prompts, including
no-active-plan and health-adjacent read-only subcases) and
`chat_message_shortcut_after_route` (53 distinct natural-language content/finance
shortcut prompts). These rows are evidence labels only; they do not alter runtime
routing. Both routes remain blocked until distinct-endpoint runtime observations
are collected, Claude/manual reviews the local raw-pair artifact, and signed
HMAC-only labels are imported with `sampleCount >= 50`, parity >= 95%, and zero
safety, quality, and degraded-not-comparable regressions. The training run also
needs seeded fixture coverage for active-plan reads plus cancelled/stale/orphaned
or no-active-plan states so cancellation cannot produce phantom training.

## Current Known Gaps

- The route still has multiple write-capable owners (`chat-action-planner`, `chat-reasoning-engine`, domain handlers). Phase 4/5 must converge these behind the ChatV2 command preview/write gateway.
- The post-route domain handler path still owns ordinary NL answers. Phase 2/3 must gather enough shadow/canary evidence before this can be retired.
- Internet research currently has its own path. Keep disabled unless its evidence policy is represented in ChatV2 answer contracts.
- There is no per-route runtime disable flag. A route is "retired" when ChatV2 owns the domain/intent upstream and the final catch-all is disabled for the tenant after soak.
- `legacyFallbackDisabled` disables only the final `routeMessage` catch-all. Write-owner retirement requires action-gateway enforcement.
