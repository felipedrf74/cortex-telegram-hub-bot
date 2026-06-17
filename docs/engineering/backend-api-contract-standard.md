# Backend API and Contract Standard

Status: canonical
Owner: backend architecture lead
Last verified: 2026-06-16
Update policy: update when REST contract conventions, route shape, or
migration discipline changes. The risk-based gate matrix at
`docs/release/risk-based-release-gate-matrix.md` is the runtime
companion.

This standard is the single source of truth for how Nexus Hub's TypeScript
backend (`src/`) exposes routes, validates input, shapes responses,
manages migrations, and writes service-layer code. It is grounded in the
OWASP REST/API guidance, OpenAPI conventions, and the Twelve-Factor App
principles, then translated into Nexus-specific rules.

## 1. Token-zero is law (must)

Operational reads/writes use REST under `/api/v1/*` directly — never via
fake chat commands, never via prompt-driven lookup.

- A "list tasks" call: `GET /api/v1/tasks/lists` ✅
- A "list tasks" call routed through `chat.sendMessage("list my tasks")`: ❌

If you find yourself adding `chatViewModel.sendMessage(...)` for a data
read, stop. The architecture rule is that data reads cost zero LLM tokens
and should always be deterministic.

## 2. Route shape (must)

Every app-facing route in `src/api/routes/` follows this shape:

```typescript
router.<verb>('/path', authMiddleware, async (req, res, next) => {
  try {
    // 1. Pull authenticated context
    const userId = req.userId; // === req.tenantId per JWT-derived policy

    // 2. Validate input (zod / explicit guards)
    const input = parseInput(req.body); // throws typed ValidationError

    // 3. Authorize at object level (not just route level)
    if (!await canAccess(userId, input.resourceId)) {
      return res.status(403).json(forbidden());
    }

    // 4. Delegate to a service
    const result = await service.doIt(userId, input);

    // 5. Shape output
    return res.json(toDto(result));
  } catch (err) {
    return next(err); // central error handler shapes 4xx/5xx
  }
});
```

Rules:

1. **`req.userId === req.tenantId`** in JWT-authenticated paths. Violations
   are tenant-isolation bugs by definition.
2. **No business logic in the route handler.** Routes parse, authorize,
   delegate, shape. A 60-line route is almost always a buried service.
3. **No direct `db.prepare(...)` in route handlers.** Database access goes
   through a service or repository module.
4. **No model/provider calls during simple read paths.** A `GET` should not
   trigger a Gemini/Claude completion unless that's the route's explicit
   purpose. This is enforced by §6.

## 3. Input validation (must)

1. **Every route validates input shape before authorization.** Reject with
   `400 INVALID_INPUT` early; do not allow malformed input to reach the
   service layer.
2. **Use zod or explicit guards.** A free-text `req.body.x` read with no
   shape check is a bug. Path parameters get the same treatment.
3. **Bound payload sizes.** `express.json({ limit: '...' })` is mounted at
   the app level; routes that accept attachments declare an explicit limit
   per route.
4. **Pagination for list responses.** Default page size 50, max 200. Never
   return an unbounded array.
5. **Idempotency keys for risky mutations.** Plan creation, calendar
   create, task create — every mutation that could be retried by the iOS
   client must accept a client-generated `idempotencyKey` and de-dupe on
   the server.

## 4. Output shape (must)

1. **Responses are typed DTOs, not raw rows.** Never `res.json(row)` from a
   prepared statement; always go through a `toDto()` mapper that drops
   internal fields (`created_by`, `tenant_id`, `_seq`, etc.).
2. **Errors use a typed envelope.** The standard envelope is:
   ```json
   { "error": { "code": "ACCOUNT_LINK_REQUIRES_VERIFICATION", "message": "...", "details": {...} } }
   ```
   The `code` is a stable identifier the iOS app can branch on. The
   `message` is operator-readable; the `details` are optional and never
   contain raw user data, raw tokens, or stack traces.
3. **`degraded: true` is the explicit "soft failure" flag.** When a route
   returns a usable but partial response (e.g. calendar fetch failed but
   plan generation succeeded), set `degraded: true` and add a
   `warnings: [...]` array. iOS reads these to render a banner.
4. **Status codes match semantics.** 400 for input validation, 401 for
   missing auth, 403 for authorization failure, 404 for not-found, 409 for
   conflict, 422 for semantically-rejectable input, 429 for rate limits,
   503 for "tried, hit a downstream failure". Never 500 for a known case;
   500 means the developer didn't handle it.
5. **No information leak via status codes.** Login errors collapse to a
   single neutral 401 regardless of "user not found" vs "wrong password";
   register errors collapse to `REGISTRATION_REJECTED 400` regardless of
   "email taken" vs "weak password".

## 5. Service / repository separation (should)

The recommended layer order is:

```
src/api/routes/<route>.ts          // HTTP shape, auth, validation
src/services/<service>.ts          // business logic, cross-cutting
src/services/<repo>.ts (or state/) // SQL access via prepared statements
src/db/migrations/...              // schema evolution
```

Service modules are pure-ish: they accept primitive inputs, return typed
outputs, and call into repository modules for I/O. Tests can mock either
layer cleanly. A service that imports `express` is a sign the layers are
collapsed and should be split.

## 6. No-side-effect read contract (must)

A `GET` route may not:

1. Mutate any row (no `INSERT`/`UPDATE`/`DELETE`).
2. Trigger a network call to an external provider unless the route's
   explicit purpose is "fetch fresh".
3. Trigger a model/provider completion unless the route's explicit purpose
   is "generate".
4. Refresh a stale OAuth token silently. The route may notice
   freshness and emit a structured warning, but the refresh runs in a
   background job, not in the request thread.

Where a `GET` legitimately needs a side effect (e.g. populate a cache on
first read), the side effect is enqueued, not awaited.

This rule is testable: `__tests__/api/<route>.test.ts` should include at
least one assertion that `db.prepare(...).run(...)` was not called for any
mutation statement during a `GET` invocation. The risk-based gate matrix
already routes `app-facing flow surfaces` to Tier-2 local smoke; the
no-side-effect assertion is the explicit unit-level form.

## 7. Idempotency (must, for mutations)

1. **Plan create, plan cancel, calendar create, task create** all accept a
   client-generated `idempotencyKey`. The server stores the key with the
   resulting resource id and returns the same id on retry.
2. **Calendar event upsert keys on `(plan_id, plan_version, session_id,
   provider)`** — the v4.14.99 ownership audit table is the canonical
   pattern for this.
3. **Task complete is idempotent on `(taskId, userId)`** with no `done_at`
   replacement on a second call.

## 8. Error handling (must)

1. **No silent failures.** A caught error must do one of: (a) emit a
   structured warning to the response with a typed code, (b) emit a
   structured pino log entry with the reqId, (c) bubble to the central
   error handler. "Catch and ignore" is forbidden.
2. **No `try { ... } catch {}`** — even an empty catch must add a comment
   explaining why the error is being swallowed and a structured log
   entry. If the comment says "should never happen", the catch is wrong.
3. **Provider fallback errors are first-class.** When the primary model
   (Gemini) fails and the fallback (Anthropic/OpenAI) is invoked, log a
   structured `provider.fallback` event so the cost/latency dashboard
   reflects it.

## 9. Migration discipline (must)

1. **Migrations are append-only and numbered.** `migrations/082_*.sql`,
   `083_*.sql`, etc. Never edit a previously-deployed migration.
2. **Every migration has an inverse.** Either an explicit
   `migrations/down/082_*.sql` or, where down-migration is impossible,
   a documented "irreversible" note alongside the migration file
   (the canonical home is `docs/release/migration-irreversible`,
   create when the first irreversible migration ships).
3. **A migration that drops a column requires a feature-flag intermediate
   step.** Step 1: stop reading the column (deploy). Step 2: stop writing
   the column (deploy). Step 3: drop the column (migration). Never collapse
   to one step.
4. **Migrations are tested under `__tests__/migrations/`.** The test
   asserts the schema after-state and (if applicable) the data-shape
   after-state on representative seeded rows.
5. **Migration rehearsal runs against a snapshot of staging DB shape.** The
   nightly CI runs full migration rehearsal on a fresh DB.

## 10. Provider routing safety (must)

Nexus runtime model routing is **configurable**. Do not hardcode "Gemini",
"Claude", "GPT", or any concrete provider as the product default in code.

1. **Use `getActiveProvider(taskType)` or
   `completeOneShotWithFallback(...)`.** Direct
   `anthropic.messages.create` / `gemini.generateContent` / `openai.chat...`
   calls are forbidden in business code. The SDK wrappers handle cost
   logging, retries, and fallback.
2. **Tool call authorization is per-user.** A tool that performs a
   side-effect (read calendar, send email, write DB) must accept a
   `userId` parameter and authorize the call against that user before
   executing. The tool dispatcher in `src/services/tool-executor.ts` is
   the single point of authorization.
3. **Cost guardrails are global and per-user.** Daily caps are enforced at
   `src/services/cost-guardrail.ts`; a per-user cap exists for any
   user-driven generative path.

## 11. OpenAPI/contract documentation (should)

Every app-facing route should be documented in
`ios-specs/02-API-SPECIFICATION.md` with:

- HTTP method + path
- Request shape (TS interface or zod schema)
- Response shape (TS interface)
- Error codes the route can produce
- Auth requirement (auth middleware vs portal token vs anonymous)

A future improvement is to generate the spec from the code. Until then, the
markdown spec is the contract; iOS reads it and writes decoders against it.

## 12. Local fixture mode (should)

For every domain (training, content, cooking, finance, secretary), the
backend exposes a fixture mode that lets iOS run end-to-end without
provider credentials. The fixture mode:

- Is gated by an explicit env flag (e.g. `NEXUS_FIXTURE_MODE=1`) AND a
  closed-beta build flag.
- Returns deterministic, recognizable data (so a UI test can pin to a
  known value).
- Never writes to production tables.
- Is covered by a smoke test that asserts the fixture mode does NOT
  activate in the production env.

## 13. Smoke evidence (must, for production deploys)

Per `docs/release/risk-based-release-gate-matrix.md`, every
backend production deploy that touches an app-facing surface produces a
JSON smoke evidence row under
`docs/release/smoke-evidence/staging-smoke-<sha>-<timestamp>.json`.
The evidence file:

- Lists the staging URL, the SHA tested, every check name and result.
- Is referenced from `docs/release/CURRENT_RELEASE_STATE.md` (the
  workspace-level release truth).
- Is pruned on a 60-day retention window with the 5 newest per smokeName
  always preserved (`scripts/smoke-evidence-prune.sh`).

A deploy claim without an evidence file is **rejected** by the release-gate
review.

## 14. Forbidden patterns

- ❌ Modifying `.env`, `data/`, `content-engine/.venv/` from code.
- ❌ Reading user data through `IN (0, ?)` or any platform-seed-merging
   predicate. Strict per-user reads only.
- ❌ Hardcoding the founder's name, email, voice, niche, audience, or
   pillar list in runtime code, prompts, or fixtures. The
   closed-beta-identity-scan blocks this; do not work around the scanner.
- ❌ `console.log` in non-test code. Use `logger.info/warn/error` with
   structured payload.
- ❌ Logging raw tokens, raw OAuth payloads, raw email contents, raw
   calendar contents, raw finance values. The `BackgroundSyncManager`
   redaction tests are the reference for what "redacted" looks like.
- ❌ Editing data on production directly via SQLite shell. Production data
   modifications go through migrations or operator-approved scripts only.
- ❌ Catching an error and returning a `200 OK` body with a "best effort"
   shape. Use the `degraded: true` envelope or fail with the right status
   code.

## 15. PR checklist (per backend change)

- [ ] Route handler stays under 60 lines (or there's an explanatory note).
- [ ] Input validated before authorization.
- [ ] `req.userId === req.tenantId` enforced where JWT-authenticated.
- [ ] Output shaped through a `toDto()` mapper.
- [ ] No mutation in `GET` routes (verified by tests where applicable).
- [ ] Idempotency key accepted for new mutation routes.
- [ ] Migration is append-only and numbered.
- [ ] Migration test asserts post-state.
- [ ] No direct provider SDK call (route through registry).
- [ ] No PII in logs.
- [ ] OpenAPI spec updated under `ios-specs/02-API-SPECIFICATION.md` when
      contract changed.
