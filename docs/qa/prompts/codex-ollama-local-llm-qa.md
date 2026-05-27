# Codex QA Prompt — WO-ollama-local-llm

This prompt drives an independent QA pass against the merged
`WO-ollama-local-llm` candidate commit. Each item maps 1:1 to a numbered
acceptance criterion in the approved plan (Revision 4, 32 items). Codex
should verify each item against the actual code, the running staging
deploy, and the SQLite database. Report PASS/FAIL with the evidence
command output for each item.

## Setup

```
git checkout <candidate_commit>
npm ci
npx tsc --noEmit
npx vitest run
```

If any of those three fail at this stage, stop and report — the candidate
commit isn't even L1.

Deploy the candidate to staging:
```
bash scripts/deploy-staging.sh
sleep 300        # 5-minute soak
bash scripts/staging-smoke.sh                  # must be 17/17
bash scripts/staging-smoke-ollama.sh           # this WO's smoke
```

## Acceptance verification (32 items)

### 1. Ollama runs locally on 127.0.0.1:11434 only; install script verifies loopback bind.
```
ssh staging-vps 'ss -ltnH | awk "\$4 ~ /:11434$/"'
# Expected: lines all start with 127.0.0.1: or [::1]:
grep -A2 'Verifying loopback' scripts/install-ollama.sh
# Expected: ss-based assertion present and fatal on non-loopback.
```

### 2. `qwen3.6:35b-a3b-q4_K_M` is installed and warm-loadable.
```
ssh staging-vps 'ollama list | grep qwen3.6:35b-a3b-q4_K_M'
ssh staging-vps 'curl -s http://127.0.0.1:11434/api/ps | jq ".models[].name"'
# Expected: model listed AND loaded (with KEEP_ALIVE=-1 it should stay loaded).
```

### 3. `OLLAMA_NUM_PARALLEL=1` and `OLLAMA_MAX_LOADED_MODELS=1` are enforced.
```
ssh staging-vps 'systemctl show ollama.service | grep -E "^Environment"'
# Expected: NUM_PARALLEL=1 and MAX_LOADED_MODELS=1 in the env list.
```

### 4. `MemoryHigh=25G`, `MemoryMax=28G`, `MemorySwapMax=1G` (NOT 22G).
```
ssh staging-vps 'systemctl show ollama.service | grep -E "^Memory(High|Max|SwapMax)"'
# Expected: MemoryHigh=25G, MemoryMax=28G (or 30064771072 etc), MemorySwapMax=1G
# Expected: NO MemoryMax=22G anywhere
```

### 5. Nexus Hub registers `ollama` as a first-class `AIProvider`.
```
grep -n "case 'ollama'" src/services/provider-registry.ts
# Expected: case branch returning new OllamaProvider() (gated by isOllamaConfigured).
grep -n "'ollama'" src/services/model-config.ts
# Expected: 'ollama' in the ProviderName union and in the provider iteration.
```

### 6. `classify` routes to Ollama immediately via env var.
```
# Hit a classify endpoint; tail api_usage:
sqlite3 staging-db "SELECT provider, model, category, ts FROM api_usage WHERE category='classify' ORDER BY ts DESC LIMIT 5;"
# Expected: most recent rows show provider='ollama' (after env flip).
```

### 7. `scriptGeneration` is a first-class task type and routes to Ollama.
```
grep -n "scriptGeneration" src/config.ts src/services/provider-fallback.ts
# Expected: explicit handling, not folded into 'chat' or 'toolUse'.
# Trigger one via scripts/llm/generate-script-local.ts; inspect script_generation_runs:
sqlite3 staging-db "SELECT provider, model, validation_status FROM script_generation_runs ORDER BY ts DESC LIMIT 3;"
# Expected: provider='ollama'.
```

### 8. `scriptGeneration` does NOT silently fall back to cloud in evaluation mode.
```
# With LOCAL_LLM_EVALUATION_MODE=true and AI_SCRIPT_GENERATION_FALLBACK=none,
# stop ollama and trigger a scriptGen call. Expect the response to surface an
# error or local-only metadata, NOT a successful cloud response.
ssh staging-vps 'sudo systemctl stop ollama'
# trigger scriptGen via API or scripts/llm/generate-script-local.ts
# Expected: error with providerMetadata.local_only=true (or equivalent), and
# NO new api_usage row with provider in {gemini, openai, anthropic} for the
# scriptGeneration category.
sqlite3 staging-db "SELECT provider, category FROM api_usage WHERE category='scriptGeneration' AND ts > (datetime('now','-5 minutes'));"
ssh staging-vps 'sudo systemctl start ollama'
```

### 9. Complex cloud fallback is allowed only for approved reasoning models.
```
# With CLOUD_REASONING_MODEL=gemini-2.5-pro AND in APPROVED_REASONING_MODELS,
# trigger a localReasoning that requires cloud. Expect cloud SDK called with
# model='gemini-2.5-pro' (not gemini-2.5-flash or another default).
# Check via spy/log inspection.
```

### 10. Cheap/nano/lite/flash/haiku/fast models cannot be used for hard reasoning fallback.
```
# Set CLOUD_REASONING_MODEL=gemini-2.5-flash AND list it in APPROVED_REASONING_MODELS.
# Trigger a localReasoning with cloud needed.
# Expected: rejected by gate; response carries warning='configured_cloud_model_matches_disallowed_substring'.
# Also check the unit test that proves disallow OVERRIDES approved list.
grep -n "disallowedSubstrings" __tests__/services/cloud-reasoning-gate.test.ts
```

### 11. Queue-full / busy errors do NOT open the circuit breaker.
```
# Send 10 parallel classify requests; first runs, next 4 queue, rest get
# capacity_exceeded → routed to gemini.
# Verify: getProviderHealth().circuit.failures for ollama did NOT increment.
grep -n "capacity_exceeded" src/services/provider-fallback.ts
# Expected: explicit branch that skips circuit increment for capacity_exceeded.
```

### 12. Provider timeout / unhealthy / model-missing errors DO open the circuit breaker.
```
# Block 127.0.0.1:11434 (iptables -A INPUT -p tcp --dport 11434 -j DROP).
# Send 3 classify requests; observe circuit opens after threshold.
grep -n "provider_unhealthy" src/services/provider-fallback.ts
# Expected: branch that increments circuit.
# Unblock: iptables -D INPUT -p tcp --dport 11434 -j DROP
```

### 13. Structured outputs are schema-validated (Zod strict) with single retry on invalid JSON.
```
grep -n ".strict()" src/services/script-generation.ts
# Expected: every schema ends in .strict()
grep -n "retry\|attempt" src/services/script-generation.ts
# Expected: explicit retry-once on Zod parse failure.
```

### 14. Thinking traces are not exposed in response text and not logged.
```
grep -n "stripThinkBlocks\|message.thinking" src/services/ollama-provider.ts
# Expected: strip function present; message.thinking explicitly excluded from log fields.
# Run the vitest case that asserts logger output contains no '<think>':
npx vitest run __tests__/services/ollama-provider.test.ts -t "thinking"
```

### 15. Local LLM usage records `cost_usd=0`, `pricing_status='zero-cost'`, `local_request_units=1`.
```
sqlite3 staging-db "SELECT provider, cost_usd, pricing_status, local_request_units FROM api_usage WHERE provider='ollama' ORDER BY ts DESC LIMIT 5;"
# Expected: cost_usd=0.0, pricing_status='zero-cost', local_request_units=1 for every row.
```

### 16. Local rate limiting is separate from dollar-based cloud cost limits.
```
ls src/services/local-llm-rate-limiter.ts        # exists
grep -n "LOCAL_LLM_USER_DAILY_CALL_LIMIT\|LOCAL_LLM_USER_HOURLY_CALL_LIMIT" src/services/local-llm-rate-limiter.ts
# Expected: limiter reads call counts from api_usage (not cost), throws LocalLLMError on cap.
```

### 17. Generated scripts run deterministic validation before acceptance.
```
grep -n "validation_status" src/services/script-generation.ts
# Expected: validators selected by artifact.kind; results attached to ScriptGenResult.
# Trigger a deliberately-broken bash script (e.g., unbalanced quote); verify
# script_generation_runs.validation_status='failed'.
```

### 18. Codex QA prompt is generated at `docs/qa/prompts/codex-ollama-local-llm-qa.md`.
```
test -f docs/qa/prompts/codex-ollama-local-llm-qa.md && echo PASS || echo FAIL
# Self-referential: this very file proves item 18.
```

### 19. Rollback works by env-var flip + restart, no code change required.
```
# Tier 1: AI_CLASSIFY_PRIMARY=gemini → restart → next classify is gemini.
# Tier 1b: OLLAMA_MODEL=qwen3.6:27b-q4_K_M → restart → /api/ps shows 27B.
# Tier 2: OLLAMA_ENABLED=false → restart → /health/detailed has no ollama provider.
# Tier 3: systemctl stop ollama → next call falls through to gemini via circuit.
# Each tier verified by env-only change + pm2 restart, no git edit.
```

### 20. `qwen3.6:27b-q4_K_M` is documented as operational rollback (not automatic in-process retry).
```
grep -n "operational rollback\|operationalRollbackModel" src/config.ts docs/runbooks/ollama-local-llm.md
# Expected: clearly documented as MANUAL switch, NOT auto-retry.
grep -n "fallbackModel.*auto\|auto.*retry" src/services/ollama-provider.ts
# Expected: NO such pattern — no automatic in-process retry against 27B.
```

### 21. `script_generation_runs` migration exists and runs on fresh + upgraded DBs.
```
ls migrations/0*script_generation_runs*.sql       # exists
npx vitest run __tests__/services/database-migrations.test.ts
# Expected: cases for fresh-DB and pre-existing-table both pass.
```

### 22. Approved cloud fallback proves the actual provider call used `CLOUD_REASONING_MODEL` via `modelOverride`.
```
grep -n "modelOverride" src/services/gemini-provider.ts src/services/openai-provider.ts src/services/anthropic-provider.ts
# Expected: each provider reads options.modelOverride and uses it for the SDK call.
# Vitest case (spy on SDK):
npx vitest run __tests__/services/cloud-reasoning-gate.test.ts -t "modelOverride"
```

### 23. `cloud-reasoning-gate` disallow-substring check overrides `APPROVED_REASONING_MODELS`.
```
# Test fixture: APPROVED_REASONING_MODELS includes 'gemini-2.5-flash';
# disallow list includes 'flash'.
# Expected: gate rejects; case present in __tests__/services/cloud-reasoning-gate.test.ts.
npx vitest run __tests__/services/cloud-reasoning-gate.test.ts -t "disallow overrides approved"
```

### 24. Cloud fallback respects privacy metadata (v3.1: redacted_only ALWAYS rejects).
```
grep -n "containsPrivateData\|allowCloudEscalation\|redactionRequired\|redaction_unsupported" src/services/cloud-reasoning-gate.ts src/services/ai-provider.ts
# Expected: gate consults containsPrivateData + allowCloudEscalation; redactionRequired is a no-op
# in v3.1; mode=redacted_only ALWAYS rejects with reason='redaction_unsupported' (no redactor
# in v3.1 after Codex round 6 found PII bypasses in v3.0's staticRedactPrompt).
npx vitest run __tests__/services/cloud-reasoning-gate.test.ts -t "privacy"
npx vitest run __tests__/services/privacy-redacted-flow.test.ts
npx vitest run __tests__/services/dispatch-privacy-e2e.test.ts
```

### 25. Generated artifacts are proposed-only, validated in a temp worktree, never auto-executed.
```
grep -n "exec\|spawn" src/services/script-generation.ts
# Expected: only execFile with { shell: false }. NO exec(), execSync(), spawn shell:true.
grep -n "sandbox\|temp.*worktree\|mkdtemp" src/services/script-generation.ts
# Expected: explicit sandbox-root + path containment.
grep -n "isSafeRelativeArtifactPath\|refine" src/services/script-generation.ts
# Expected: path safety predicate enforced by Zod refine.
```

### 26. PM2 cluster mode (`NODE_APP_INSTANCE > 0`) with memory queue backend fails at startup.
```
grep -n "NODE_APP_INSTANCE" src/services/ollama-provider.ts
# Expected: startup guard that throws fatal when instance > 0 AND backend='memory'.
# Manual test: NODE_APP_INSTANCE=1 npm start → fails fast with clear error.
```

### 27. Install script verifies loopback bind, sets `OLLAMA_LOAD_TIMEOUT=15m`, accepts memory overrides.
```
grep -n "OLLAMA_LOAD_TIMEOUT\|OLLAMA_MEMORY_HIGH" scripts/install-ollama.sh
# Expected: both present, defaults shown.
# Already covered by item 1 for loopback.
```

### 28. `scripts/llm/local-llm-smoke.ts` validates Qwen3.6 with `think=true` + JSON schema against the real daemon.
```
ssh staging-vps 'cd /home/dominguez/telegram-hub-bot && npx tsx scripts/llm/local-llm-smoke.ts'
# Expected: 11/11 with token-rate metrics, isColdLoad flag, no thinking content in returned text.
```

### 29. Exactly ONE `api_usage` row is written per successful Ollama call.
```
sqlite3 staging-db "SELECT COUNT(*) FROM api_usage WHERE provider='ollama' AND ts > datetime('now','-1 minutes');"
# Trigger one classify call; expect the count to increment by exactly 1.
# Vitest case:
npx vitest run __tests__/services/ollama-provider.test.ts -t "exactly one api_usage row"
```

### 30. Generated artifact paths are safe relative paths and cannot escape the sandbox.
```
grep -n "isSafeRelativeArtifactPath\|startsWith(sandboxRoot" src/services/script-generation.ts
# Expected: predicate + post-resolve absolute-path containment check + symlink rejection.
# Vitest:
npx vitest run __tests__/services/script-generation.test.ts -t "path safety"
```

### 31. Validators run with `shell:false`; model-provided command strings never executed.
```
grep -n "execFile\|{ shell:" src/services/script-generation.ts
# Expected: only execFile(cmd, args, { shell: false, cwd: sandboxRoot, timeout: ... }).
# Expected: NO exec(), execSync(), spawn(..., {shell: true}), or eval().
```

### 32. PM2 single-instance check in staging-smoke when memory queue backend is in use.
```
grep -n "pm2 jlist\|instances" scripts/staging-smoke-ollama.sh
# Expected: PM2 instance count assertion when LOCAL_LLM_QUEUE_BACKEND=memory.
bash scripts/staging-smoke-ollama.sh
# Expected: smoke passes with PM2 reporting nexus-hub instances=1.
```

## Report format

Codex should report:
```
WO-ollama-local-llm QA report
candidate_commit: <sha>
base_commit:      <sha>

Acceptance criteria summary:  PASS X / Y, FAIL Z

[for each failing item]:
  Item N: <criterion>
  Evidence command(s):
    $ <cmd>
    <output>
  Expected: <what should have happened>
  Observed: <what actually happened>
  Severity: blocking | major | minor

Verification floor (vitest):
  Before: 718 files / 10,525 tests passing
  After:  <X> files / <Y> tests passing
  Floor maintained: YES | NO

Recommendation: APPROVE for L3 promotion | RETURN for fixes
```
