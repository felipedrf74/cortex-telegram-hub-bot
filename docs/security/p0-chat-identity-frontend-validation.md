# P0 Chat identity — frontend validation runbook

The backend P0 fixes are unit-test-validated (1001/1001). Live two-account walk-through on a signed iOS build is required before this issue is closed against production.

## Required environment

- Two real Nexus Hub accounts:
  1. `nexushubbot` (the account that originally received "You're Felipe").
  2. A second account whose actual saved display name is `Felipe` (e.g., the canonical owner account).
- A signed TestFlight or device-attached build of the iOS app pointing at staging or local (NOT production yet — see `STAGING.md`).
- Backend running with the fixes from `feature/p0-chat-identity-tenant-isolation-fix`.

## Walk-through

### 1. Cold-start as `nexushubbot`

1. Reset the iOS app (delete + reinstall, or use the "Reset / Sign out" path in Settings if available).
2. Launch the app. Confirm onboarding routes you to the login flow.
3. Sign in as `nexushubbot`.
4. Open the Chat tab.
5. Type: `Who am I?`
6. **Expected:** assistant replies with text along the lines of "This authenticated session is signed in as `<nexushubbot's saved first name>`. I will only use data tied to this account and tenant." OR "I can see the authenticated session, but there is no saved profile name. I will only use data tied to this authenticated user and tenant." (depending on whether `nexushubbot` has a saved `first_name`).
7. **Required:** screenshot the response.

### 2. Variants — Portuguese and other identity questions

While still signed in as `nexushubbot`:

1. Send `Quem sou eu?` → expected: PT response (same shape).
2. Send `Qual é o meu nome?` → expected: PT response.
3. Send `Como me chamo?` → expected: PT response.
4. Send `Who am I signed in as?` → expected: EN response.
5. Send `Which account am I using?` → expected: EN response.
6. **Required:** screenshot each response.

### 3. Account switch

1. Sign out from `nexushubbot`.
2. Sign in as the Felipe account.
3. Open the Chat tab.
4. **Verify:** previous session's messages from `nexushubbot` are NOT visible.
5. Send `Who am I?`.
6. **Expected:** assistant replies with Felipe's display name (NOT `nexushubbot`).
7. **Required:** screenshot.

### 4. Reverse switch

1. Sign out from Felipe.
2. Sign back in as `nexushubbot`.
3. Open Chat.
4. **Verify:** Felipe's messages are NOT visible. Conversation list is scoped to `nexushubbot`.
5. Send `Who am I?`.
6. **Expected:** still scoped to `nexushubbot`. The fast-path is deterministic; it should be impossible to get "You're Felipe" here.
7. **Required:** screenshot.

### 5. App restart

1. Force-quit the iOS app while signed in as `nexushubbot`.
2. Relaunch.
3. Open Chat.
4. **Verify:** still signed in as `nexushubbot`. Messages list is the `nexushubbot` history.
5. Send `Who am I?` again.
6. **Expected:** consistent response.
7. **Required:** screenshot.

### 6. Free-form follow-ups

While signed in as `nexushubbot`:

1. Send: `What is my name?` → expected: same fast-path identity response.
2. Send: `Tell me my training plan` → expected: response that does NOT name "Felipe" anywhere.
3. Send: `Suggest a content idea` → expected: response that does NOT assume Felipe's voice / pillars / worldview.
4. **Required:** screenshot each. If any response still mentions "Felipe", file as a P1.

## Capture the request payload (optional but recommended)

Use Charles Proxy / mitmproxy / `Network` log to capture the POST `/api/v1/chat/message` body. Confirm:
- Request body contains only `{ text, replyToId?, attachments? }`. No `userId`, `tenantId`, `displayName`, `profileName`.
- Response body contains `metadata.type === 'authenticated_identity'` and `metadata.userId === <nexushubbot users.id>` for identity questions.

## Pass criteria

- Every "Who am I?" response across PT, EN, both accounts, all 6 walk-through steps returns the authenticated user's correct identity (or a graceful "I don't have enough account context" if the saved profile name is empty).
- No response contains literal "Felipe" or "Dominguez" while signed in as `nexushubbot`.
- Conversation list is partitioned per account.
- App restart preserves the signed-in account; does not show prior account's messages.

## Fail criteria

- ANY "Who am I?" answer returns a name different from the signed-in account.
- Any cross-account message bleed-through.
- Any persona-asserted text ("You build with AI", "You're a marathon runner", etc. when the user's actual profile says otherwise).

## After validation

- If PASS: append the screenshots / paths to this doc, mark the P0 closed in `p0-chat-identity-final-report.md`.
- If FAIL: file a P0 / P1 issue with the exact text observed and the request/response payload.
