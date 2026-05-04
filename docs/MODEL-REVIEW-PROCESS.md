# Model Review Process

Status: canonical
Owner: AI provider routing lead (Felipe)
Last verified: 2026-05-04
Update policy: run monthly on the 1st; update when provider routing matrix or task-type pinning changes.

## Monthly Review (1st of each month)

### 1. Cost Analysis
```bash
npx tsx scripts/cost-comparison.ts
```
Compare against baseline. If costs increased >20%, investigate which domain/provider caused the spike.

### 2. Model Updates
Check for new model releases:
- [Anthropic Models](https://docs.anthropic.com/en/docs/about-claude/models)
- [Google Gemini Models](https://ai.google.dev/gemini-api/docs/models)
- [OpenAI Models](https://platform.openai.com/docs/models)

If a cheaper model is available that maintains quality:
1. Update `MODEL_OPTIONS` in `src/services/model-config.ts`
2. Update cost table in the relevant provider file
3. Test with `scripts/test-gemini-ptbr.ts` (or equivalent for other providers)
4. Deploy with feature flag to one domain first

### 3. Quality Check
- Review user complaints or routing errors in logs
- Check circuit breaker states: `GET /api/provider-health`
- Check domain routing: `GET /api/domain-routing`
- Verify Portuguese quality hasn't degraded

### 4. Deprecation Check
Google deprecates models with ~6 months notice. Check:
- `gemini-2.0-flash` deprecated June 2026
- Update defaults before deprecation dates

## Domain Routing Configuration

### Current Assignment (April 2026)
| Domain | Provider | Model | Rationale |
|--------|----------|-------|-----------|
| Classifier | Gemini | gemini-2.5-flash-lite | 10x cheaper than Haiku for JSON classification |
| Secretary | Anthropic | claude-sonnet-4-6 | Best tool-use reliability for multi-step calendar/task ops |
| Triathlon | Gemini | gemini-3-flash | Good tool-use + 6x cheaper than Haiku |
| Content | Gemini | gemini-3-flash | Creative tasks, no tools needed |
| Finance | Gemini | gemini-3-flash | Calculation + formatting |
| Cooking | Gemini | gemini-3-flash | Simple Q&A, cheapest option |

### How to Change Routing
```bash
# Via environment variable (requires restart)
GEMINI_DOMAINS=cooking,finance,content,triathlon

# Via portal API (runtime, no restart)
curl -X POST http://localhost:8200/api/domain-routing/toggle \
  -H "Authorization: Bearer $PORTAL_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"enabled": true, "domains": ["cooking","finance","content","triathlon"]}'

# Via portal UI: Mission Control → Domain Routing section
```

### Rollback
```bash
# Disable all Gemini routing instantly
curl -X POST http://localhost:8200/api/domain-routing/toggle \
  -H "Authorization: Bearer $PORTAL_TOKEN" \
  -d '{"enabled": false}'
```

## Cost Targets
| Metric | Target | Alert Threshold |
|--------|--------|-----------------|
| Daily spend | <$0.50 | >$1.00 |
| Monthly spend | <$15 | >$30 |
| Cost per message | <$0.03 | >$0.05 |
| Gemini % of traffic | 60-70% | <40% (fallback storm) |
