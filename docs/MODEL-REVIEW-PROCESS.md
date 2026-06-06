# Model Review Process

Status: canonical
Owner: AI provider routing lead (Felipe)
Last verified: 2026-05-19
Update policy: run monthly on the 1st; update when provider routing matrix or task-type pinning changes.

## Monthly Review (1st of each month)

### 1. Cost Analysis
```bash
npx tsx scripts/cost-comparison.ts
DATABASE_PATH=/path/to/bot.db npx tsx scripts/chat-cost-scenarios.ts
```
Compare against baseline. If costs increased >20%, investigate which domain/provider caused the spike.

`scripts/chat-cost-scenarios.ts` recomputes `api_usage` with current model-rate matching and compares:
- corrected current routing
- classifier/router retained on Gemini 2.5 Flash-Lite
- eligible structured chat moved to GPT-5.4 nano
- generic no-local-read context removal
- Batch pricing for eval/backfill rows only

### 2. Model Updates
Check for new model releases:
- [Anthropic Models](https://docs.anthropic.com/en/docs/about-claude/models)
- [Google Gemini Models](https://ai.google.dev/gemini-api/docs/models)
- [OpenAI Models](https://platform.openai.com/docs/models)

If a cheaper model is available that maintains quality:
1. Update `MODEL_OPTIONS` in `src/services/model-config.ts`
2. Update `src/services/model-pricing.ts`, the central input/output/cache rate registry
3. Run `npx tsx src/tools/model-pricing-report.ts` and confirm no active `api_usage` model is unresolved. Unresolved production rows are not free: quota enforcement charges the Sonnet-4.6 sentinel ceiling rate and emits a deduped operator alert until the registry is fixed.
4. Test with `scripts/test-gemini-ptbr.ts` (or equivalent for other providers)
5. Deploy with feature flag to one domain first

### 3. Quality Check
- Review user complaints or routing errors in logs
- Check circuit breaker states: `GET /api/provider-health`
- Check domain routing: `GET /api/domain-routing`
- Verify Portuguese quality hasn't degraded
- Run the offline fixture bake-off before changing production defaults:
  ```bash
  STAGING=true npx tsx src/tools/chat-model-bakeoff.ts
  ```
  The report must score successful-answer cost, skill/route/risk precision, local-read correctness, no-local-truth violations, PT/EN quality, action safety, p95 latency when observations exist, token totals, and estimated cost per successful answer.
  Rows whose Source column is `contract_baseline` are deterministic contract checks and do not call a model. Use `--observations <jsonl>` when comparing real model outputs.

Fixture token ceilings (`maxInputTokens` and `maxOutputTokens`) are eval gates only in this branch. They prevent the bilingual fixture corpus and bake-off reports from drifting, but the runtime context compiler does not reject live requests solely because a fixture ceiling would be exceeded.

### 4. Deprecation Check
Google deprecates models with ~6 months notice. Check:
- `gemini-2.0-flash` deprecated June 2026
- Update defaults before deprecation dates

## Domain Routing Configuration

### Current Assignment (April 2026)
| Domain | Provider | Model | Rationale |
|--------|----------|-------|-----------|
| Classifier | Gemini | gemini-2.5-flash-lite | 10x cheaper than Haiku for JSON classification |
| Secretary | OpenAI | gpt-5.4-nano | Low-cost structured tool-use path with Gemini fallback |
| Triathlon | Gemini | gemini-2.5-flash | Keep safer coaching/reasoning until paired eval proves nano |
| Content | Gemini | gemini-2.5-flash | Creative range and bilingual tone |
| Finance | Gemini | gemini-2.5-flash | Calculation + formatting; nano/Flash-Lite candidates require eval |
| Cooking | Gemini | gemini-2.5-flash | Baseline route; recipes are nano candidates behind quality gates |

### Recommended Skill/Subskill Eval Targets
| Skill / subskill | Candidate primary | Fallback | Gate before rollout |
|------------------|-------------------|----------|---------------------|
| Generic skill Q&A / direct chat | gpt-5.4-nano | gemini-2.5-flash | no-local-truth and PT/EN quality pass |
| Secretary summaries and task/calendar reads | gpt-5.4-nano | gemini-2.5-flash | local grounding and no false success |
| Simple reminders/tasks/notes parsing | deterministic registry/parser, then gemini-2.5-flash-lite | gpt-5.4-nano | read-back and confirmation policy |
| Training coaching | gemini-2.5-flash | gpt-5.4-mini | safety, recovery, periodization, calendar feasibility |
| Content creative scripts/hooks | gemini-2.5-flash | gpt-5.4-mini | bilingual creative quality |
| Content structured analysis/SEO/planning | gpt-5.4-nano | gemini-2.5-flash | structure and factuality |
| Cooking recipes/meal plans | gpt-5.4-nano | gemini-2.5-flash | recipe quality gate and no local-read leakage |
| Cooking pantry/shopping/preference CRUD | deterministic parser, then gemini-2.5-flash-lite | gpt-5.4-nano | scoped write/read-back |
| Finance categorization/extraction | deterministic rules or gemini-2.5-flash-lite | gpt-5.4-nano | amount/category precision |
| Finance explanations/budget summaries | gpt-5.4-nano | gemini-2.5-flash | local grounding and calculation checks |
| Web/current/source-backed answers | gemini-2.5-flash with search | honest degraded answer | cited sources or explicit degradation |

### How to Change Routing
```bash
# Via environment variable (requires restart)
GEMINI_DOMAINS=cooking,finance,content,triathlon

# Domain experiment override (requires restart; use for staged canaries)
AI_DOMAIN_PROVIDER_OVERRIDES=cooking=openai,finance=openai

# Via portal API (runtime, no restart)
curl -X POST http://localhost:8200/api/domain-routing/toggle \
  -H "Authorization: Bearer $PORTAL_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"enabled": true, "domains": ["cooking","finance","content","triathlon"]}'

# Via portal UI: Mission Control → Domain Routing section
```

Invalid `AI_DOMAIN_PROVIDER_OVERRIDES` entries are dropped and logged with the raw key/value. Treat those warnings as deployment hygiene failures; they usually mean an experiment is not actually running.

### Rollback
```bash
# Disable all Gemini routing instantly
curl -X POST http://localhost:8200/api/domain-routing/toggle \
  -H "Authorization: Bearer $PORTAL_TOKEN" \
  -d '{"enabled": false}'

# Clear domain experiment overrides
unset AI_DOMAIN_PROVIDER_OVERRIDES
```

## Batch And Flex Policy

Batch is approved for offline bilingual evals, model bake-offs, historical labeling, regression scoring, and backfills. Flex is optional for non-urgent background jobs after separate validation.

Do not use Batch or Flex for live Telegram/iOS chat replies, action planning, local reads, reminders, finance answers, or training advice. Slower or unavailable live responses are treated as a reliability regression, even when token pricing is lower.

Prompt-cache savings are not assumed until provider calls are wired to provider-specific cache primitives. The chat context compiler emits `cacheablePrefixHash` for observability and future cache-key validation; it is not, by itself, a Gemini/OpenAI cache activation.

## Cost Targets
| Metric | Target | Alert Threshold |
|--------|--------|-----------------|
| Daily spend | <$0.50 | >$1.00 |
| Monthly spend | <$15 | >$30 |
| Cost per message | <$0.03 | >$0.05 |
| Gemini % of traffic | 60-70% | <40% (fallback storm) |
