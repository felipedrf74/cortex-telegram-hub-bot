# Content Full Nexus Local Smoke

Date: 2026-04-29
Branch: `qa/nexus-hub-focused-review-selected-areas`
Runtime: local backend on `http://127.0.0.1:8200`
Database: `data/content-full-nexus-smoke.db`
State dir: `.local/content-full-nexus-smoke`

## Scope

This smoke validates Content Creation inside the local Nexus product engine:

- backend APIs
- auth/session
- tenant/user scope
- permissions
- Chat tenant safety
- Secretary/Training/Cooking/Finance/Content cross-skill fixtures
- Content Creation REST surfaces
- Content references
- Content voice memory
- Content workflow/topic lifecycle
- Content quality/evaluation harness
- model-routing fixture/resource controls
- local SQLite database/cache
- portal read surfaces
- iOS simulator local-backend rendering

## Provider Controls

Default smoke used:

```bash
NEXUS_LOCAL_ALLOW_MODEL_CALLS=0
```

The local runner blanks provider keys and sets `ANTHROPIC_ENABLED=false`.

Updated fixture-provider behavior:

- Provider routing now initializes a deterministic local `fixture` provider when `NEXUS_LOCAL_ALLOW_MODEL_CALLS=0` or `NEXUS_MODEL_FIXTURE_MODE=1`.
- Startup should report `routing(fixture)` instead of a no-provider failure or direct-Anthropic fallback wording.
- This removes local resource-control ambiguity, but it still does not prove live provider quality or fallback behavior.

## Commands Run

Repeatable wrapper now available:

```bash
npm run smoke:content:local
```

Equivalent direct script:

```bash
scripts/content-full-nexus-local-smoke.sh run
```

The wrapper defaults to `NEXUS_LOCAL_ALLOW_MODEL_CALLS=0`, `NEXUS_MODEL_FIXTURE_MODE=1`, a local smoke SQLite DB, normalized Content eval-history persistence, and cleanup on exit. It was validated in full local backend mode:

```bash
scripts/content-full-nexus-local-smoke.sh run
```

That run built/started the backend, passed authenticated API smoke 13/13, passed cross-skill fixtures, passed Chat tenant smoke 12 pass / 2 partial / 0 fail, passed Content focused tests 15 files / 124 tests including portal backend scope coverage, persisted a 15-case 91/100 eval run, and confirmed no local backend/content-engine listener remained after cleanup. It does not replace rich iOS workflow smoke.

```bash
FULL_NEXUS_STATE_DIR=.local/content-full-nexus-smoke \
DATABASE_PATH="$PWD/data/content-full-nexus-smoke.db" \
FULL_NEXUS_RESET_DB=1 \
NEXUS_LOCAL_ALLOW_MODEL_CALLS=0 \
scripts/full-nexus-local-engine.sh cleanup
```

```bash
FULL_NEXUS_STATE_DIR=.local/content-full-nexus-smoke \
DATABASE_PATH="$PWD/data/content-full-nexus-smoke.db" \
NEXUS_LOCAL_ALLOW_MODEL_CALLS=0 \
scripts/full-nexus-local-engine.sh doctor
```

```bash
FULL_NEXUS_STATE_DIR=.local/content-full-nexus-smoke \
DATABASE_PATH="$PWD/data/content-full-nexus-smoke.db" \
NEXUS_LOCAL_ALLOW_MODEL_CALLS=0 \
scripts/full-nexus-local-engine.sh up
```

```bash
FULL_NEXUS_STATE_DIR=.local/content-full-nexus-smoke \
DATABASE_PATH="$PWD/data/content-full-nexus-smoke.db" \
NEXUS_LOCAL_ALLOW_MODEL_CALLS=0 \
scripts/full-nexus-local-engine.sh smoke
```

```bash
npm test -- --run \
  __tests__/services/content-tenant-scope.test.ts \
  __tests__/services/content-reference-provenance.test.ts \
  __tests__/services/content-domain-ontology.test.ts \
  __tests__/services/content-editorial-workflow.test.ts \
  __tests__/services/content-memory-profile.test.ts \
  __tests__/services/content-radar-engine.test.ts \
  __tests__/services/content-generation-quality.test.ts \
  __tests__/services/content-novelty-reuse.test.ts \
  __tests__/services/content-cross-skill-orchestration.test.ts \
  __tests__/services/content-day-to-day-evaluation.test.ts \
  __tests__/services/content-eval-history.test.ts \
  __tests__/services/provider-registry-fixture-mode.test.ts \
  __tests__/api/content-admin-write-auth.test.ts \
  __tests__/services/content-dashboard-service.test.ts \
  __tests__/api/content-dashboard.test.ts
```

```bash
FULL_NEXUS_STATE_DIR=.local/content-full-nexus-smoke \
DATABASE_PATH="$PWD/data/content-full-nexus-smoke.db" \
NEXUS_LOCAL_ALLOW_MODEL_CALLS=0 \
scripts/full-nexus-local-engine.sh cross-skill-fixtures
```

```bash
npm run eval:content -- \
  --markdown docs/content/content-eval-baseline-results.md \
  --json reports/content-eval/content-eval-latest.json \
  --fail-under 85
```

```bash
npm test -- --run \
  __tests__/services/model-routing-local-smoke.test.ts \
  __tests__/services/provider-fallback-domain-routing.test.ts \
  __tests__/services/domain-provider-router.test.ts \
  __tests__/services/ai-provider.test.ts
```

```bash
FULL_NEXUS_STATE_DIR=.local/content-full-nexus-smoke \
DATABASE_PATH="$PWD/data/content-full-nexus-smoke.db" \
NEXUS_LOCAL_ALLOW_MODEL_CALLS=0 \
scripts/full-nexus-local-engine.sh chat-tenant-smoke
```

## Manual Local API Probes

The smoke also used a local auth token from `.local/content-full-nexus-smoke/local-ios-auth.json` and called:

- `GET /api/v1/content/home`
- `GET /api/v1/content/pipeline`
- `GET /api/v1/content/ideas`
- `POST /api/v1/content/books`
- `GET /api/v1/content/books`
- `POST /api/v1/content/channels`
- `GET /api/v1/content/channels`
- `POST /api/v1/content/voice-dna`
- `GET /api/v1/content/voice-dna`
- `GET /api/v1/content/radar-preferences`
- `PUT /api/v1/content/radar-preferences`
- `POST /api/v1/content/topics`
- `PATCH /api/v1/content/topics/:id`
- `GET /api/books`
- `GET /api/content-knowledge`

Tenant probe:

- created local User A and User B
- added Tenant B private book
- verified User A could not list/delete Tenant B book
- verified User A could not read Tenant B voice memory

## iOS Simulator Probe

Simulator: `iPhone 17 Pro`
Bundle: `me.nexushub.app`

Launch args:

```text
-nexus_debug_local_auth_import YES
-nexus_allow_local_backend YES
-nexus_base_url http://127.0.0.1:8200
```

Environment:

```text
NEXUS_LOCAL_AUTH_IMPORT_PATH=/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot/.local/content-full-nexus-smoke/local-ios-auth.json
```

Result:

- iOS build/run succeeded.
- Home loaded local backend data without a server-unreachable banner.
- Content skill card was visible.
- Content workspace opened and rendered local Content state, Content flow, workbench, script generator entry, topic scheduler entry, Voice DNA/backstage surfaces.

Screenshot artifact:

```text
/var/folders/ys/pphsc0rn6m7246r817g6r1pr0000gn/T/screenshot_optimized_f940a134-7125-4883-a60f-6579928dd7e4.jpg
```
