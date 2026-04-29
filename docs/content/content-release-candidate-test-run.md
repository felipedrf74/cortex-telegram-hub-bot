# Content Creation Release Candidate Test Run

Date: 2026-04-29  
Branch: `release/content-creation-production-candidate`  
Candidate version: `content@2.3.0-rc.1`

## Summary

| Area | Result |
| --- | ---: |
| Migration replay | PASS |
| Content service/security/foundation tests | PASS, 13 files / 97 tests |
| Content API/regression tests | PASS, 17 files / 148 tests |
| Remaining Content regression tests | PASS, 19 files / 170 tests |
| Content-to-Secretary agenda ledger proof | PASS, 2 files / 19 tests |
| Content-engine sidecar fixture script smoke | PASS WITH CONDITIONS |
| Sensitive log-redaction focused pass | PASS, 7 files / 110 tests |
| Local fixture provider routing | PASS, 1 file / 2 tests |
| Portal scoped Content management | PASS, 3 files / 44 tests |
| Content quality evaluation harness | PASS WITH CONDITIONS, 91/100 |
| Content eval-history persistence | PASS, 1 file / 3 tests; persisted latest 15-case eval |
| Content one-command smoke wrapper | PASS WITH CONDITIONS, full local backend wrapper path validated |
| Typecheck | PASS |
| Lint | PASS |
| Diff whitespace check | PASS |
| iOS local smoke | Not rerun; prior summary PASS WITH CONDITIONS |
| Portal local smoke | Not rerun; prior summary PASS WITH CONDITIONS |
| Full local product smoke | PASS WITH CONDITIONS, rerun via Content wrapper |

## Commands Run

```bash
node - <<'NODE'
const fs=require('fs'); const path=require('path'); const Database=require('better-sqlite3');
const db=new Database(':memory:');
db.pragma('foreign_keys = ON');
for (const f of fs.readdirSync('migrations').filter(f=>f.endsWith('.sql')).sort()) db.exec(fs.readFileSync(path.join('migrations', f), 'utf8'));
const content=db.prepare("SELECT skill_id, version, status, quality_gate_status FROM skill_versions WHERE skill_id='content' ORDER BY id").all();
console.log(JSON.stringify({ migrations: 'ok', content }, null, 2));
db.close();
NODE
```

Result: PASS. `content@2.0.0` remains active and `content@2.3.0-rc.1` is candidate.

```bash
npm test -- --run __tests__/services/content-tenant-scope.test.ts __tests__/services/content-reference-provenance.test.ts __tests__/services/content-security-red-team.test.ts __tests__/services/content-generation-quality.test.ts __tests__/services/content-editorial-workflow.test.ts __tests__/services/content-memory-profile.test.ts __tests__/services/content-radar-engine.test.ts __tests__/services/content-novelty-reuse.test.ts __tests__/services/content-domain-ontology.test.ts __tests__/services/content-cross-skill-orchestration.test.ts __tests__/services/content-day-to-day-evaluation.test.ts __tests__/services/skill-memory.test.ts __tests__/services/skill-version-registry.test.ts
```

Result: PASS, 13 files / 97 tests.

```bash
npm test -- --run __tests__/api/content-home-route.test.ts __tests__/api/content-reference-routes.test.ts __tests__/api/content-learning-routes.test.ts __tests__/api/content-script-duration.test.ts __tests__/api/content-script-quota.test.ts __tests__/api/content-script-route-utils.test.ts __tests__/api/content-topic-routes.test.ts __tests__/api/content-pipeline-routes.test.ts __tests__/api/content-ideas-routes.test.ts __tests__/api/content-intelligence-routes.test.ts __tests__/api/content-generation-meta.test.ts __tests__/api/internal-routes.test.ts __tests__/api/skills-routes.test.ts __tests__/services/content-workflow-user-scope.test.ts __tests__/services/content-dedup-routing.test.ts __tests__/services/channel-learner-scope.test.ts __tests__/services/python-engine-hardening.test.ts
```

Result: PASS, 17 files / 148 tests.

```bash
npm test -- --run __tests__/services/content-dashboard-service.test.ts __tests__/services/content-learning-store.test.ts __tests__/services/content-intelligence.test.ts __tests__/services/content-home-view-state.test.ts __tests__/services/content-notifications.test.ts __tests__/services/content-topic-secretary-sync.test.ts __tests__/services/content-owner-scope.test.ts __tests__/skills/content-skill-refactor-qa-validation.test.ts __tests__/api/chat-content-refinement.test.ts __tests__/api/content-admin-write-auth.test.ts __tests__/api/content-topic-context.test.ts __tests__/api/content-learning-route-utils.test.ts __tests__/api/content-home-route-utils.test.ts __tests__/api/content-topics-recommendation.test.ts __tests__/api/content-dashboard.test.ts __tests__/api/content-intelligence-detail.test.ts __tests__/api/content-intelligence-summary.test.ts __tests__/api/content-intelligence-route-utils.test.ts __tests__/api/content-script-utils.test.ts
```

Result: PASS, 19 files / 170 tests.

```bash
npm test -- --run __tests__/services/content-editorial-workflow.test.ts __tests__/services/secretary-scheduling-arbitrator.test.ts
```

Result: PASS, 2 files / 19 tests. This focused pass includes the backend Content-to-Secretary agenda ledger proof: a Content schedule request submits through Secretary, creates a `content` agenda item, stores `secretary_agenda_item_id` on the Content object, and records a workflow event with Secretary decision metadata.

```bash
npm test -- --run __tests__/services/python-engine-hardening.test.ts
CONTENT_ENGINE_FIXTURE_MODE=1 NEXUS_LOCAL_ALLOW_MODEL_CALLS=0 CONTENT_ENGINE_PORT=18102 ENV=production content-engine/.venv313/bin/python content-engine/main.py
curl -fsS -X POST http://127.0.0.1:18102/api/v1/script -H 'content-type: application/json' -d '{"topic":"fixture content planning reset","mode":"quick","format":"Short","language":"en-US","render_mode":"chat","script_style":"bullets","max_duration_minutes":1,"target_duration_seconds":30,"user_id":501,"tenant_id":101}'
```

Result: PASS WITH CONDITIONS. `python-engine-hardening.test.ts` passed 51/51. The sidecar started locally and `/api/v1/script` returned a degraded, topic-grounded fixture response with mock sources and `AI proxy disabled by Content Engine fixture mode.` No live provider call was made. This does not prove live source extraction or routed-provider output quality.

```bash
npm test -- --run __tests__/utils/log-sanitizer.test.ts __tests__/utils/logger-redaction.test.ts __tests__/services/error-monitor.test.ts __tests__/services/error-categorizer.test.ts __tests__/api/authenticated-support-routes-scope.test.ts __tests__/services/python-engine-hardening.test.ts __tests__/services/sensitive-log-sinks.test.ts
```

Result: PASS, 7 files / 110 tests. Structured logger redaction covers prompt/message/context/memory/reference/draft/script/voice fields; durable error/client log sinks sanitize sensitive context before persistence; Sentry/operator-alert forwarding and telemetry summaries use sanitized context; Python Content Engine and identified TypeScript model parse-failure paths no longer log raw provider/model response previews.

```bash
npm test -- --run __tests__/services/provider-registry-fixture-mode.test.ts
```

Result: PASS, 1 file / 2 tests. Provider routing now initializes `routing(fixture)` when local model calls are disabled, avoiding false direct-Anthropic fallback wording while preserving live routing for normal modes.

```bash
npm test -- --run __tests__/api/content-admin-write-auth.test.ts
```

Result: PASS, 1 file / 13 tests. Portal Content link list/upsert/delete routes require explicit tenant/user scope and preserve read/write token boundaries. Book, channel, and manual Voice DNA mutations now also require explicit user/tenant scope and use scoped predicates. Tenant-scoped voice synthesis returns `UNSUPPORTED_SCOPE` until the voice agent accepts explicit scope.

```bash
npm test -- --run __tests__/services/content-dashboard-service.test.ts __tests__/api/content-dashboard.test.ts
```

Result: PASS, 2 files / 31 tests. Legacy portal Content mutations are disabled in favor of scoped v1 routes, and unscoped dashboard reads return only platform/system seed Content rows rather than all tenant/user rows.

```bash
npm run eval:content -- --json reports/content-eval/content-eval-latest.json --markdown docs/content/content-eval-baseline-results.md --fail-under 85 --persist-db reports/content-eval/content-eval-history.sqlite
```

Result: PASS WITH CONDITIONS, score 91/100, 15 cases, 0 critical failures, fixture mode. The compiled CLI persisted normalized eval metadata and per-case scores into `reports/content-eval/content-eval-history.sqlite` without raw prompts, transcripts, drafts, references, or provider output text.

```bash
node - <<'NODE'
const Database=require('better-sqlite3');
const db=new Database('reports/content-eval/content-eval-history.sqlite',{readonly:true});
const runs=db.prepare('select run_id, mode, overall_score, case_count, release_gate, provider, model, real_provider_calls, production_data_used from content_eval_runs order by id desc limit 3').all();
const cases=db.prepare('select count(*) as count from content_eval_case_results where run_id=?').get(runs[0].run_id);
console.log(JSON.stringify({runs,casesForLatest:cases.count},null,2));
db.close();
NODE
```

Result: PASS. Latest run had 15 cases, score 91/100, `PASS_WITH_CONDITIONS`, provider `fixture`, model `deterministic-content-fixture`, `real_provider_calls=0`, and `production_data_used=0`.

```bash
scripts/content-full-nexus-local-smoke.sh run
```

Result: PASS WITH CONDITIONS. The new one-command Content smoke wrapper built and started the local backend, passed authenticated API smoke 13/13, passed cross-skill fixtures, passed Chat tenant smoke 12 pass / 2 partial / 0 fail, passed Content focused tests 15 files / 124 tests, persisted a 15-case 91/100 eval run, and cleanup confirmed no local backend/content-engine listener remained. This validates the local backend wrapper path; rich iOS workflow smoke remains separate.

```bash
npm run typecheck
npm run lint
git diff --check
```

Result: PASS.

## Notes

- `npm run eval:content` includes a build step and completed successfully.
- No production data was used.
- No deployment was performed.
- Live provider sampling was not run.
- iOS/portal/full local product smoke summaries are referenced from existing docs rather than rerun in this pass.
