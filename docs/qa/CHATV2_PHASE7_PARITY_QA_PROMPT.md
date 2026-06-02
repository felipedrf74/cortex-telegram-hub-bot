# Claude Code QA Prompt — ChatV2 Phase 7 Legacy Parity Review

You are an independent reviewer for the ChatV2 / ChatCoreV2 completion work.
Read-only unless the owner explicitly asks you to edit. Do not commit, push, or deploy.

## Goal

Verify whether the Phase 7 legacy natural-language retirement gate can be advanced
without fabricating evidence. You may inspect local raw-pair review artifacts when
they are explicitly supplied under `.local/`, but the only acceptable output for
parity import is safe aggregate/HMAC-only metadata. Do not commit, copy into docs,
or persist raw prompts, raw messages, raw responses, task titles,
calendar/email/finance/health content, or other private user data.

## Context

- Worktree: `/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot`
- Branch to validate: `codex/chat_improvement_goal`
- Way-of-work files to read first: `CLAUDE.md`, `docs/qa/work-orders/WO-chatv2-completion.md`, `docs/ai/chatv2-route-exit-inventory.md`
- Work Order: `docs/qa/work-orders/WO-chatv2-completion.md`
- Route inventory: `docs/ai/chatv2-route-exit-inventory.md`
- Safe parity review export: `docs/release/eval-evidence/chatv2-legacy-parity-review-latest.json`
- Parity label validator: `src/services/chat-legacy-parity-labels.ts`
- Parity label importer: `scripts/chatv2-import-legacy-parity-labels.ts`
- Parity observation importer: `scripts/chatv2-import-legacy-parity-observations.ts`
- Historical research-route observation file rejected by June 2 QA for route retirement
  because it reused a tiny health-adjacent prompt set to pad 50 rows:
  `.local/chatv2-parity/run-20260602T011350Z-seeded-write-refresh/observations-runtime-research-current-head-50.ndjson`
- Historical research-route manifest:
  `.local/chatv2-parity/run-20260602T011350Z-seeded-write-refresh/observations-runtime-research-current-head-50.manifest.json`
- Historical research-route local raw review artifact:
  `.local/chatv2-parity/run-20260602T011350Z-seeded-write-refresh/observations-runtime-research-current-head-50.review.json`
- Historical v1.2 research-route diagnostic run that must not be imported as
  retirement parity because every row is `degraded_not_comparable`:
  `.local/chatv2-parity/run-20260602T111201Z-research-v12-distinct-anthropic/observations-runtime-research-v12-anthropic-50.ndjson`
- Historical v1.2 diagnostic manifest:
  `.local/chatv2-parity/run-20260602T111201Z-research-v12-distinct-anthropic/observations-runtime-research-v12-anthropic-50.manifest.json`
- Historical v1.2 OpenAI-backed non-degraded research-route observation file
  that Claude already blocked for answer-quality regressions:
  `.local/chatv2-parity/run-20260602T113745Z-research-v12-openai/observations-runtime-research-v12-openai-budget-override-50.ndjson`
- Historical v1.2 OpenAI-backed manifest:
  `.local/chatv2-parity/run-20260602T113745Z-research-v12-openai/observations-runtime-research-v12-openai-budget-override-50.manifest.json`
- Historical v1.2 OpenAI-backed local raw review artifact:
  `.local/chatv2-parity/run-20260602T113745Z-research-v12-openai/observations-runtime-research-v12-openai-budget-override-50.review.json`
- Historical OpenAI-backed manifest facts:
  `observationRows=50`,
  `routePromptVersion=chat_v2_legacy_parity_route_prompts@1.2.0`,
  `promptSamplingPolicy=no_repeated_prompts_for_answer_quality_research`,
  `distinctPromptsByRoute.selective_internet_research=52`,
  `observationsSha256=5604f93fb3ecf286f1740b7d2a6e657b26df22b3a59af2a9cfa49645dd7b0056`,
  `rawReviewArtifactLocalOnly=true`.
- Claude's review of that OpenAI-backed package blocked
  `selective_internet_research`: 46 / 50 quality parity, 4
  `chatv2_worse_quality`, 0 safety regressions, 0 degraded rows. The confirmed
  blockers were Spanish/es-419 responses drifting into Portuguese, one thinner
  current-release answer, and one scientific query using weaker source types
  than requested. Do not sign labels from that package.
- Post-review code changes to inspect:
  `src/services/chat-turn-contract.ts`,
  `src/services/chat-context-compiler.ts`,
  `src/services/chat-internet-research.ts`,
  `__tests__/services/chat-turn-contract.test.ts`,
  `__tests__/api/chat-routes.test.ts`,
  and `__tests__/services/chat-internet-research.test.ts`. They add explicit
  Spanish research-language detection before the research route, output-language
  contracts, Spanish localized source/degraded copy, and stronger source-quality
  instructions for scientific/current-release research.
- Post-fix Gemini evidence attempt:
  `.local/chatv2-parity/run-20260602T121822Z-research-v12-locale-source-fix-gemini`.
  This attempt was stopped after repeated Gemini 503 `UNAVAILABLE` errors and
  emitted no observation artifact. Do not import or review it as parity evidence.
- Historical post-fix Gemini-backed research-route observation file; do not
  sign because it has one degraded/not-comparable row and predates the current
  corpus:
  `.local/chatv2-parity/run-20260602T133620Z-research-v12-post-locale-fix-openai/observations-runtime-research-v12-postfix-openai-50.ndjson`
- Historical post-fix Gemini-backed manifest:
  `.local/chatv2-parity/run-20260602T133620Z-research-v12-post-locale-fix-openai/observations-runtime-research-v12-postfix-openai-50.manifest.json`
- Historical post-fix Gemini-backed local raw review artifact:
  `.local/chatv2-parity/run-20260602T133620Z-research-v12-post-locale-fix-openai/observations-runtime-research-v12-postfix-openai-50.review.json`
- Historical post-fix Gemini-backed manifest facts:
  `observationRows=50`,
  `routePromptVersion=chat_v2_legacy_parity_route_prompts@1.2.0`,
  `promptSamplingPolicy=no_repeated_prompts_for_answer_quality_research`,
  `distinctPromptsByRoute.selective_internet_research=52`,
  `observationsSha256=556e62b8ea8a4a6c2b8aa001c9bcbc74fac8bc7707142a298ce9c3555276eb61`,
  `rawReviewArtifactLocalOnly=true`,
  runtime-tool summary 49 / 50 with 1 `degraded_not_comparable`.
- Do not sign a retirement label with `degradedNotComparableCount=0` from this
  post-fix Gemini-backed artifact unless your independent review proves the
  manifest/runtime degraded classification is wrong. If you classify the degraded
  sample as `not_comparable_degraded`, keep the route blocked or request a fresh
  non-degraded provider run.
- Post-fix Gemini-backed retry/backoff research-route observation file that was
  reviewed and blocked:
  `.local/chatv2-parity/run-20260602T161650Z-research-v15-backoff-gemini/observations-runtime-research-v15-backoff-gemini-50.ndjson`
- Post-fix Gemini-backed retry/backoff manifest:
  `.local/chatv2-parity/run-20260602T161650Z-research-v15-backoff-gemini/observations-runtime-research-v15-backoff-gemini-50.manifest.json`
- Post-fix Gemini-backed retry/backoff local raw review artifact:
  `.local/chatv2-parity/run-20260602T161650Z-research-v15-backoff-gemini/observations-runtime-research-v15-backoff-gemini-50.review.json`
- Expected v15 manifest facts to verify, not trust:
  `observationRows=50`,
  `routePromptVersion=chat_v2_legacy_parity_route_prompts@1.2.0`,
  `promptSamplingPolicy=no_repeated_prompts_for_answer_quality_research`,
  `distinctPromptsByRoute.selective_internet_research=52`,
  `observationsSha256=5604f93fb3ecf286f1740b7d2a6e657b26df22b3a59af2a9cfa49645dd7b0056`,
  `rawReviewArtifactLocalOnly=true`,
  runtime-tool summary 50 / 50 with 0 `degraded_not_comparable` rows and 0
  target-route misses.
- Claude's review of the v15 retry/backoff package blocked
  `selective_internet_research`: runtime-tool comparison reported 50 / 50, but
  raw-pair review found roughly 9 truncated or incomplete ChatV2 answers. Do not
  sign or import labels from the v15 package. The 50 / 50 runtime-tool result is
  non-signable because Claude/manual verdicts override the comparator.
- Current research corpus version for the next fresh run:
  `chat_v2_legacy_parity_route_prompts@1.4.0`. A post-truncation-fix run must
  use this current corpus version or newer.
- Local provider note: `.env.local` has Gemini configured and does not have
  OpenAI or Anthropic keys configured. A cleaner OpenAI-only rerun requires a
  rotated OpenAI key supplied through a secure local environment path. Do not use
  or persist API keys pasted in chat.
- Current research corpus source:
  `src/services/chat-legacy-parity-route-prompts.ts`
- Readiness CLI: `scripts/chatv2-completion-readiness.ts`

## Review Task

1. Confirm the rollout/runbook uses the real runtime levers:
   `CHAT_CORE_V2_ORCHESTRATOR_MODE=canary|on`, `CHAT_CORE_V2_ALLOWED_DOMAINS`,
   per-tenant `allowedDomains`, `CHAT_CORE_V2_ACTION_GATEWAY_MODE=enforce`,
   `CHAT_CORE_V2_LEGACY_WRITE_FALLTHROUGH_BLOCK=on`, and final catch-all
   `legacyFallbackDisabled=true`. Flag any instruction that sets
   `CHAT_CORE_V2_ORCHESTRATOR_MODE=enforce`.
2. Verify attributed fallback rows are emitted from the live `/api/v1/chat/message`
   path via `recordChatCoreV2LegacyFallbackSample`, not only from test-only/helper
   seams. Require route-level coverage that proves `chat_v2_legacy_fallback_attribution_counter`
   receives safe domain/owner/method labels for both a ChatV2-handled turn and a
   legacy fallback turn.
3. Inspect the 9 route-exit rows where `parityLabelNeeded=true` in
   `docs/release/eval-evidence/chatv2-legacy-parity-review-latest.json`.
4. For each row, decide whether the available L2/runtime aggregate evidence is
   enough to label the row as replaced and tested.
5. If a row is not supportable, mark it `BLOCKED` and explain the missing
   evidence in safe aggregate terms only.
6. For `selective_internet_research`, do not sign or import labels from the
   historical `observations-runtime-research-current-head-50.*` files above.
   Also do not sign/import the historical
   `observations-runtime-research-v12-anthropic-50.*` diagnostic files unless a
   new non-degraded run exists; those files prove the historical v1.2
   corpus/manifest shape but not answer-quality parity because web search was
   unavailable locally.
   The
   `observations-runtime-research-v15-backoff-gemini-50.*` files were reviewed
   and are blocked because roughly 9 ChatV2 answers were truncated or
   incomplete. Do not trust the 50 / 50 runtime-tool match count as independent
   proof; it is non-signable after Claude/manual raw-pair review found quality
   regressions.
   Verify a fresh observation run uses
   `chat_v2_legacy_parity_route_prompts@1.4.0`, at least 50 distinct public-query
   research prompts, `promptSamplingPolicy=no_repeated_prompts_for_answer_quality_research`,
   and `distinctPromptsByRoute.selective_internet_research >= samplesByRoute.selective_internet_research`.
   Reject any run that pads rows by repeating prompts or over-concentrates on
   health-adjacent/personal injury prompts.
7. Inspect the OpenAI web-search fallback implementation for research:
   `src/services/chat-internet-research.ts`, `src/services/openai-provider.ts`,
   and `__tests__/services/chat-internet-research.test.ts`. Confirm it is
   default-off, requires `CHAT_INTERNET_RESEARCH_OPENAI_WEB_SEARCH_FALLBACK=true`
   plus `OPENAI_API_KEY`, and receives only the safe public-query prompt.
8. For each `selective_internet_research` raw pair in the latest post-fix
   review artifact, classify the sample as one of:
   `equivalent`, `chatv2_better`, `equivalent_but_different`,
   `chatv2_worse_quality`, `chatv2_worse_safety`, or
   `not_comparable_degraded`. Specifically inspect answer-quality parity,
   source/evidence behavior, locale preservation, health-adjacent conservatism,
   no raw-private web query leaks, and no mutual degraded response counted as
   parity.
   The v15 post-fix non-degraded artifact is also blocked; do not review it as
   the current signable candidate. The next signable candidate must be a fresh
   post-truncation-fix run from corpus
   `chat_v2_legacy_parity_route_prompts@1.4.0` or newer. Require special
   attention to es/es-419 locale fidelity, including prompts that begin with
   English `Search` but whose research content is Spanish,
   science/current-release source quality, and complete/non-truncated answers.
9. If a row is supportable, emit one NDJSON line using only this schema:

```json
{"schemaVersion":"chat_v2_legacy_parity_label.v1","routeId":"...","replaced":true,"tested":true,"sampleCount":50,"matchingCount":48,"oldOwner":"...","replacement":"...","evaluator":"claude","peerReviewSignoffHash":"<64-char-sha256-of-this-peer-review-artifact>","evidenceSource":"runtime_route","safetyRegressionCount":0,"qualityRegressionCount":0,"degradedNotComparableCount":0,"reviewRubricVersion":"chat_v2_legacy_parity_review_rubric.v2"}
```

Allowed label fields are exactly:

- `schemaVersion`
- `routeId`
- `replaced`
- `tested`
- `sampleCount`
- `matchingCount`
- `oldOwner`
- `replacement`
- `evaluator`
- `peerReviewSignoffHash`
- `evidenceSource`
- `safetyRegressionCount`
- `qualityRegressionCount`
- `degradedNotComparableCount`
- `reviewRubricVersion`

Do not include raw input/output text, titles, examples, snippets, or debug payloads.
If you need to discuss an example, describe it by route/capability class only.

## Acceptance Rules

- A route can be labeled only when `sampleCount >= 50`,
  `matchingCount / sampleCount >= 0.95`, the replacement is tested, and no raw
  private-data storage is observed.
- Keep pre-ChatV2 shells that are intentionally unchanged do not need parity
  labels unless the export marks `parityLabelNeeded=true`.
- Do not mark a route as replaced just because code exists. Phase 7 requires
  evidence, not implementation intent.
- Runtime-tool/self-attested rows are not enough to retire a route. A retirement
  label must be reviewed by `claude` or `manual` and include a 64-character
  SHA-256 `peerReviewSignoffHash` of the independent review/signoff artifact.
- Independent runtime labels must have `safetyRegressionCount=0` and must be
  backed by an HMAC-only observation artifact plus observer manifest. Independent
  runtime labels must also include `qualityRegressionCount=0`,
  `degradedNotComparableCount=0`, and
  `reviewRubricVersion="chat_v2_legacy_parity_review_rubric.v2"`. Verify the raw
  local review artifact is complete against that manifest: same row count, same
  HMAC sample IDs/routes, and matching `observationsSha256`. Do not review a
  curated subset.
- 95% parity is not sufficient if any mismatch is `chatv2_worse` on safety:
  false success claim, missed write firewall, missing confirmation, wrong
  verification status, raw cloud/private leak, wrong locale, broken response or
  action-card contract, or tenant/user leakage.
- The corpus must be held-out and adversarial: en, pt-BR, pt-PT, pt-AO, es,
  es-419, mixed; negation/hypotheticals; ambiguous cancel/dismiss; duplicate
  task titles; read-vs-write collisions; recipe generation vs cooking read;
  confirmation/cancel flows.
- Answer-quality research evidence must use distinct public-query prompts, not
  repeated prompt padding. Research prompts should cover current events, factual
  lookup, product comparison, public finance, public law, science, sports,
  travel/weather, and only a limited health-adjacent subset. Verify safe web
  query behavior: no raw private calendar/task/finance/health/email/user state
  may be sent to a web-search provider.
- Do not copy `importLabelTemplate` rows from the review export into the importer
  unless you have independently produced old-vs-ChatV2 matching counts. Coverage
  rows and valid response-contract rows are not parity labels.
- This is L2/local evidence only. Do not call it production proof.

## Suggested Commands

```bash
npx tsx scripts/chatv2-completion-readiness.ts --db ./data/local.db --limit=360
node -e "const fs=require('fs'); const j=JSON.parse(fs.readFileSync('docs/release/eval-evidence/chatv2-legacy-parity-review-latest.json','utf8')); console.log(JSON.stringify(j.rows.filter(r=>r.parityLabelNeeded).map(r=>({routeId:r.routeId,label:r.routeLabel,samples:r.runtimeSamples,valid:r.validSamples,coverage:r.coverageRate,methods:r.observedRouteMethods,caps:r.observedFinalCapabilities})),null,2));"
npx vitest run __tests__/services/chat-legacy-parity-labels.test.ts __tests__/services/chat-legacy-retirement-readiness.test.ts
```

If you create a label file after owner approval, validate it with:

```bash
npx tsx scripts/chatv2-import-legacy-parity-observations.ts --write --observations=./path/to/observations.ndjson --manifest=./path/to/observations.manifest.json --qa-review-id=<safe-review-id> --routes=<route_id> --db=./data/local.db
npx tsx scripts/chatv2-import-legacy-parity-labels.ts --write --labels=./path/to/labels.ndjson --peer-review-signoff=./path/to/claude-review.md --observations=./path/to/observations.ndjson --manifest=./path/to/observations.manifest.json --raw-review-artifact=./path/to/observations.review.json --db=./data/local.db
npx tsx scripts/chatv2-completion-readiness.ts --db ./data/local.db --limit=360
```

Prefer the observation importer when possible. It accepts sample-level rows with
only `routeId`, HMAC sample id, `matched`, `tested`, old owner, replacement,
evaluator, evidence source, and optional safe reason code, then derives the
aggregate parity label. This is safer than hand-writing `matchingCount`.

## Report Format

Return:

1. Verdict: `PASS`, `PARTIAL`, or `BLOCKED`.
2. Route-by-route table for the 9 `parityLabelNeeded` rows.
3. Any NDJSON labels that are safe and justified.
4. Blockers for the remaining rows.
5. Commands you ran and results.
6. Risks/assumptions.
