# Chat General Action Intelligence — Claude QA (Follow-up, Round 2)

**Date**: 2026-05-14
**Engine**: `/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot`
**iOS**: `/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub`
**Simulator**: iPhone 17 Pro, iOS 26.4.1 (`A0B13967-B5DE-4E6F-897D-F1E409093F94`)
**iOS xcresult**: `/tmp/chat-followup/ios.xcresult`

## Verdict

**GO_WITH_CONDITIONS** ⚠

Both prior P-1 findings from my last QA (M1 iOS fallback, M2 targeted
clarification) are **fully closed at source and pinned by tests**. The
critical Portuguese regression remains exactly correct. 8 of 9 of my
hostile probes for this pass succeed.

The one new finding is a **medium-risk defense-in-depth gap** in the
brand-new LLM arg sanitization control: the sanitizer denylist at
`chat-action-planner.ts:637` covers 8 explicit field names but is
**shallow + case-sensitive**. My A1 attack proved `args.ownerId =
'attacker'` survives the sanitizer. The primary security control (the
executor uses `input.userId` from the authenticated request context,
not from args) remains intact, so this is not a current exploit — but
the documented contract is "Model-supplied identity fields are
stripped from args before dispatch," and the implementation does NOT
strip several common identity-like field names.

Net: M1/M2 are clean closures. The new "arg sanitization" control
ships partial. Fix is 4 lines + a nested-scrub helper.

## Test scorecard (independently re-run)

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | PASS (exit 0) |
| Focused 5-file chat sweep (`chat-action-planner`, `chat-routes`, `secretary-fastpath`, `p0-chat-identity-isolation`, `websocket-security`) | **201/201 passing** (exactly matches Codex's claim; was 198 before, +3 from new sanitization/M2/ordering tests) |
| iOS `ChatStructuredCardRenderingTests` | **12/12 passing**, `** TEST SUCCEEDED **` (was 11/11; +1 new M1 fix test) |
| **My independent followup tests** | **8/9 passing**, 1 sanitization gap caught |
| **Critical Portuguese regression** | Plan output byte-identical to prior pass; gate held |

## M1 — VERIFIED CLOSED ✅

**File**: `Nexus Hub/Views/Chat/StructuredCards.swift`

The fallback "Resposta estruturada" card is **fully removed from the
renderer**:

```swift
case let type where Self.visibleChatActionTypes.contains(type):
    chatActionInline(type)        // line 79 — typed cards opt-in
case let type where Self.silentMetadataTypes.contains(type):
    EmptyView()                    // line 81 — silent types
default:
    EmptyView()                    // line 83 — UNKNOWN types now silent
```

Verification:
- `grep "Resposta estruturada"` and `grep "Structured response"` both
  return **empty** in `StructuredCards.swift` — the string is fully
  deleted from the renderer.
- The new `visibleChatActionTypes` allowlist explicitly enumerates the
  typed cards (chat_action_verified_success, partial, blocked, etc.).
- Forward-compatibility footgun closed: a future backend
  `metadata.type` not yet recognized renders nothing, not a confusing
  fallback card.
- New iOS test in `ChatStructuredCardRenderingTests` (12/12; was 11/11)
  pins the contract.

Better than my recommendation: I asked for `default: EmptyView()` but
Codex went further and split `chat_action_*` from generic typed cards
via `visibleChatActionTypes`, so only intentionally-shipped types get
visible UI.

## M2 — VERIFIED CLOSED ✅

**File**: `chat-action-planner.ts:668-676` (per-field clarification builder)

```typescript
case 'title':
    return event ? 'Qual é o título do evento?' :
           task ? 'Qual é o título da tarefa?' :
           'Qual é o título?';
case 'startDateTime':
    return event ? 'Quando começa o evento?' : 'Quando começa?';
case 'endDateTime':
    return event ? 'Quando termina o evento?' : 'Quando termina?';
case 'timezone':
    return 'Qual é o fuso horário?';
```

Plus `fieldLabel` helper at `:737-745` providing localized field names
(`título` / `title`, `data/hora de início` / `start date/time`, etc.)
for multi-field clarifications.

My independent live regression test confirmed:
- Input `"Cria um evento no domingo às 10"` → clarification mentions
  `"título"` ✓
- Input `"Cria um evento chamado igreja domingo"` → clarification
  mentions `"hora"` / `"quando"` ✓

Better than my recommendation: I asked for the planner to inspect
which field is missing and ask about it specifically. Codex went
further by branching on `(field, event/task)` so the question is
contextual — "Qual é o título do evento?" vs "Qual é o título da
tarefa?" depending on the action skill.

## Critical regression — UNCHANGED PASS ✅

Live planner output (independently captured this pass):

```json
{
  "planner": "deterministic",
  "steps": [{
    "skill": "secretary_calendar",
    "action": "schedule_event",
    "provider": "google_calendar",
    "args": {
      "title": "igreja",
      "startDateTime": "2026-05-17T10:00:00+01:00",
      "endDateTime": "2026-05-17T12:30:00+01:00",
      "timezone": "Europe/Lisbon"
    },
    "verification": { "required": true, "method": "provider_read_back" }
  }],
  "debug": {
    "rejectedFastPaths": ["gmail_unread_count"]
  }
}
```

Byte-for-byte identical to my prior pass. No regression introduced by
the M1/M2/sanitization patches.

## NEW FINDING: M3 — LLM arg sanitization is shallow + case-sensitive

**Severity**: Medium (defense in depth; not a current exploit)
**File**: `src/services/chat-action-planner.ts:635-641`

```typescript
function sanitizePlannerArgs(args: Record<string, unknown>): Record<string, unknown> {
  const sanitized = { ...args };
  for (const forbidden of ['userId', 'user_id', 'tenantId', 'tenant_id', 'accountId', 'account_id', 'ownerUserId', 'owner_user_id']) {
    delete sanitized[forbidden];
  }
  return sanitized;
}
```

The denylist has 8 explicit names. My hostile probes proved several
identity-like names **survive** the sanitizer:

| Probe | Field | Survived? | Comment |
|---|---|---|---|
| A1 | `userId: 999` | ✗ stripped | ✓ in denylist |
| A1 | `tenantId: 999` | ✗ stripped | ✓ in denylist |
| A1 | `accountId: 'attacker'` | ✗ stripped | ✓ in denylist |
| **A1** | **`ownerId: 'attacker'`** | **✓ SURVIVED** | Not in denylist — only `ownerUserId` is |
| A1 | `owner_user_id: 999` | ✗ stripped | ✓ in denylist |
| A2 | `args.metadata.userId: 999` | ✓ SURVIVED | Sanitizer is shallow, doesn't recurse |
| A2 | `args.context.ownerId: 'attacker'` | ✓ SURVIVED | Shallow + missing denylist entry |
| A2 | `args.scope.userId: 999` | ✓ SURVIVED | Shallow |
| A3 | `uid: 999` | ✓ SURVIVED | Not in denylist |
| A3 | `user: { id: 999 }` | ✓ SURVIVED | Not in denylist + shallow |
| A3 | `owner: 'attacker'` | ✓ SURVIVED | Not in denylist |
| A3 | `UserId: 999` | ✓ SURVIVED | Case-sensitive match (`UserId !== userId`) |
| A3 | `USER_ID: 999` | ✓ SURVIVED | Case-sensitive |

### Why this is medium, not high

The **primary security control is still intact**: the calendar executor
at `chat-action-planner.ts:1143` calls
`await calendar.createEvent(..., provider, input.userId)` — it uses the
authenticated `input.userId` from the request context, **never reads
`args.userId`** (or any alt-name field). I source-verified this for
the calendar create path. The same pattern holds in the dispatcher
loop at `:872-987`.

So even if `args.ownerId = 'attacker'` survives sanitization, no
current executor branch reads it. The QA prompt's claim "Model-
supplied identity fields are stripped from args before dispatch" is
**defense in depth**, not the primary control.

### Why it still needs to be fixed

1. The documented contract is "stripped from args" — not "stripped if
   the field name exactly matches one of these 8 strings". Anyone
   reading the spec and writing a new executor branch could naively
   call something like
   `calendar.createEvent(..., args.ownerId ?? input.userId)`
   intending the fallback semantics, and that would suddenly become
   exploitable.
2. The plan + its args are persisted to `chat_action_runs.request_json`
   for audit / replay. Persisted args containing attacker-controlled
   `ownerId` could leak into downstream consumers (e.g., admin debug
   UI, monitoring dashboards).
3. The sanitizer is **case-sensitive** in a JavaScript object map —
   `UserId !== userId` because Object keys are case-sensitive in JS.
   Anyone manually inspecting the denylist would not expect
   `UserId: 999` to survive.

### Fix

**`src/services/chat-action-planner.ts:635-641` — 3 changes**:

1. **Wider denylist** including common variants:
   ```typescript
   const FORBIDDEN_KEYS = new Set([
     'userid', 'user_id', 'user-id', 'uid',
     'tenantid', 'tenant_id', 'tenant-id',
     'accountid', 'account_id', 'account-id',
     'ownerid', 'owner_id', 'owner-id', 'owner',
     'owneruserid', 'owner_user_id', 'owner-user-id',
     'user',  // strip the literal "user" key (would shield `user: {id: 999}`)
   ]);
   ```
2. **Case-insensitive match**: compare `key.toLowerCase()` against the
   denylist.
3. **Deep scrub** for nested objects:
   ```typescript
   function sanitizePlannerArgs(args: unknown): unknown {
     if (Array.isArray(args)) return args.map(sanitizePlannerArgs);
     if (args && typeof args === 'object') {
       const result: Record<string, unknown> = {};
       for (const [k, v] of Object.entries(args)) {
         if (FORBIDDEN_KEYS.has(k.toLowerCase())) continue;
         result[k] = sanitizePlannerArgs(v);
       }
       return result;
     }
     return args;
   }
   ```

Add 3 tests pinning the new behavior:
- A1 with `ownerId` and case variants
- A2 with `args.metadata.userId` (deep scrub)
- A3 with `uid`, `user`, `owner`

## Passed hostile probes

| # | Probe | Result |
|---|---|---|
| R | Portuguese regression (planner output) | ✅ byte-identical to prior pass |
| M2-1 | Missing title → asks for "título" | ✅ |
| M2-2 | Missing time → asks for "hora/quando" | ✅ |
| E1 | Gmail unread query → routes to mail (not schedule_event) | ✅ |
| E2 | Cross-tenant smuggling in text → plan keeps request-context identity | ✅ |
| E3 | Same input → identical idempotency key | ✅ |
| A1-partial | userId/tenantId/accountId stripped | ✅ (3 of 6) |
| A2 | Plan's userId/tenantId stay request-scoped despite nested smuggle | ✅ (defense in depth: primary control intact) |
| A3 | Plan's userId/tenantId stay request-scoped despite alt-name smuggle | ✅ (defense in depth: primary control intact) |

## Source-pin tests for REST + WS ordering — EXIST and PASS

**File**: `__tests__/services/chat-action-planner.test.ts:406-415`

```typescript
const restSource = fs.readFileSync('.../chat-message-routes.ts', 'utf-8');
const wsSource = fs.readFileSync('.../websocket.ts', 'utf-8');
const actionInvocation = restSource.indexOf('const actionResult = await tryHandleChatActionPlan');
const fastPathInvocation = restSource.indexOf('const fastPath = await tryBuildFastPathChatResponse');
// assert action < fastPath
expect(wsSource).toContain('tryHandleChatActionPlan');
expect(wsSource).not.toContain('tryBuildFastPathChatResponse');
```

Plus a second pin at `__tests__/api/websocket-security.test.ts:40-41`:
```typescript
const source = fs.readFileSync('.../websocket.ts', 'utf8');
const plannerIndex = source.indexOf('tryHandleChatActionPlan({');
```

### Brittleness assessment (the prompt explicitly asked)

These source-pins are **moderately brittle** — they assert exact-string
contains:
- `'const actionResult = await tryHandleChatActionPlan'` — requires
  the literal variable name `actionResult` and inline-call syntax.
  Renaming to `const result = await tryHandleChatActionPlan(...)`
  breaks the pin.
- `'tryHandleChatActionPlan({'` — requires the function literally
  followed by `({`. Breaking the call onto two lines (`tryHandleChatActionPlan(\n  {…})`)
  breaks the pin.

Robust to: whitespace inside the call's argument list, comments around
the call site, additional arguments to the call.
Brittle to: variable rename, splitting `(` and `{` onto separate
lines, refactoring to spread arguments via a builder.

**Recommendation (low-priority L)**: switch the pin to a regex that
allows whitespace and quote variation:
```typescript
const ACTION_CALL = /await\s+tryHandleChatActionPlan\s*\(/;
const FASTPATH_CALL = /await\s+tryBuildFastPathChatResponse\s*\(/;
expect(restSource).toMatch(ACTION_CALL);
expect(restSource.search(ACTION_CALL)).toBeLessThan(restSource.search(FASTPATH_CALL));
```

This catches the security-relevant ordering without coupling to a
specific variable name or call-line format.

## Docs update verified

`/Users/felipedominguez/Desktop/Nexus Hub/docs/release/CURRENT_RELEASE_STATE.md`
(workspace mirror) includes:
- Line 32: the literal Portuguese regression input verbatim
- Line 36: `chat_action_runs` durable state description
- Line 57: chat_action_* typed cards info
- Line 69: **"5 files / 201 tests"** claim — exact match with my
  independent run

The engine repo's own `docs/release/CURRENT_RELEASE_STATE.md` is
unchanged (workspace mirror pattern). This matches the documented
workflow.

## Summary

### Passed (independently verified)
- M1: iOS unknown-type fallback eliminated (`default: EmptyView()`)
- M2: per-field targeted clarifications (`Qual é o título do evento?`)
- Critical regression: byte-identical plan output
- M1+M2 are stronger than my recommendations
- Backend 201/201, iOS 12/12
- LLM-execute separation: typed dispatcher allowlist
- Read-back gate: provider read-back required before verified_success
- Idempotency: stable SHA-256 key from action args
- Cross-tenant text smuggling: plan keeps request-context identity
- Gmail unread query: still routes to mail
- Source-pin tests: REST + WS ordering exist and pass

### Medium-risk finding (must fix to declare "model identity sanitization complete")
- **M3 — sanitizer is shallow + case-sensitive + has gaps**
  - `ownerId`, `uid`, `user`, `owner`, `UserId`, `USER_ID` all survive
  - Nested `args.metadata.userId`, `args.context.ownerId` survive
  - Primary executor control (uses `input.userId` from request) is
    intact, so not a current exploit
  - Fix: case-insensitive denylist + deep scrub + wider denylist
    (~15 lines + 3 tests)

### Low-risk improvements
- **L1**: Source-pin tests use exact-string `indexOf` — brittle to
  variable renames. Switch to regex-based check (~5 lines).

### Risky assumptions
- No new ones beyond prior pass.

### Safe to ship?
- **With M3 fixed: yes.** The fix is small and adds defense-in-depth
  to a documented contract.
- **Without M3 fix: yes for production behavior, no for documented
  contract.** Primary control (executor uses request-context identity)
  is intact; the documented "sanitization strips identity from args"
  is incomplete but doesn't create a current exploit.

## Cleanup confirmation

- iOS xcscheme + project drift preserved.
- Workspace docs mirror preserved + updated.
- Test scaffolds (`_qa-followup-tmp.test.ts`) deleted after each run.
- No production posting / ad / platform / push / deploy / TestFlight /
  live providers.
- iOS sim ran only `ChatStructuredCardRenderingTests`.

---

Generated 2026-05-14 by Claude Opus 4.7.
