# iOS JWT Rotation Runbook

Status: canonical
Owner: backend security lead (Felipe)
Last verified: 2026-07-13
Update policy: update when iOS JWT signing or verification semantics change.

## Contract

iOS access tokens are issued with a `kid` header. Verification accepts every
configured key whose rotation window is still open. Tokens minted before Batch
21 did not carry `kid`; those continue to verify with `IOS_API_JWT_SECRET`
until natural expiry so existing sessions survive the migration.

Configured keys live in `IOS_API_JWT_KEYS` as JSON:

```json
[
  {
    "kid": "ios-api-2026-05-05",
    "secret": "old-secret",
    "verifyUntil": "2026-05-07T12:00:00.000Z"
  },
  {
    "kid": "ios-api-2026-05-06",
    "secret": "new-secret",
    "active": true
  }
]
```

`IOS_API_JWT_ACTIVE_KID` can pin the issuing key. If no key list is configured,
the API issues tokens with `kid=ios-api-current` using `IOS_API_JWT_SECRET`.

## Rotate

1. Confirm `IOS_JWT_EXPIRY` for the environment. The rotation overlap must be
   at least the configured access-token lifetime plus 24 hours and never less
   than 8 days. The current 7-day default therefore requires 192 hours.
2. Pin two non-JWT HMAC values to the current effective legacy JWT secret
   before enabling the keyring:

   - `CHAT_CONFIRMATION_HMAC_SECRET` preserves pending confirmation tokens.
   - `CHAT_V2_EVIDENCE_HMAC_SECRET` preserves evidence identity.

   Store them independently in each environment and verify they are non-empty
   without printing them. Startup rejects a configured JWT keyring until both
   HMAC values are pinned and pass the same minimum strength policy.
3. Run the helper with explicit current signing material. It refuses to emit a
   plan if neither a current keyring nor the legacy secret is available. Use a
   protected deployment env file or export the three JWT variables explicitly;
   the helper never guesses from an absent environment. Capture output in a
   mode-600 file rather than the terminal:

```bash
install -d -m 700 .local/rotation
umask 077
npx tsx scripts/rotate-jwt-signing-key.ts --env-file=.env \
  > .local/rotation/ios-jwt-keyring.env
chmod 600 .local/rotation/ios-jwt-keyring.env
# Explicit equivalent for the current 7-day token lifetime:
npx tsx scripts/rotate-jwt-signing-key.ts --env-file=.env \
  --rotation-hours=192 > .local/rotation/ios-jwt-keyring.env
```

4. Store the emitted `IOS_API_JWT_KEYS` and `IOS_API_JWT_ACTIVE_KID` values in
   the deployment environment.
   The generated active entry has no cutoff. Every inactive entry has a finite
   canonical ISO-8601 cutoff. Keep `IOS_API_JWT_SECRET` unchanged throughout
   the overlap so pre-keyring no-`kid` tokens remain valid.
5. Restart the API process. Startup must reject malformed JSON, duplicate key
   ids, a missing/conflicting active key, weak secrets, invalid lifetimes, any
   cutoff on the active key, an unbounded inactive key, or either missing/weak
   dedicated HMAC.
6. Confirm `/api/v1/auth/me` and WebSocket authentication accept a
   freshly-issued token and an old-token
   smoke token from before the restart.
7. Re-mint staging-only fixture tokens; they intentionally have a longer
   lifetime and must not lengthen the production-grade overlap.
8. After the rotation window has elapsed, prove both pinned HMAC values are
   unchanged from step 2, remove expired key entries from
   `IOS_API_JWT_KEYS`, and replace `IOS_API_JWT_SECRET` with a new
   environment-specific legacy/no-kid fallback. Because confirmations use the
   independently pinned `CHAT_CONFIRMATION_HMAC_SECRET`, new issuance does not
   extend the JWT-secret drain and pending tokens remain valid. If the pin from
   step 2 cannot be proven, do not rotate the legacy secret; establish a
   controlled no-new-confirmations window for the full maximum token lifetime
   plus margin before retrying. Confirm old kid and no-kid tokens fail while
   the active key still authenticates REST and WebSocket requests. Keep both
   pinned HMAC values unchanged.

## Rollback

Atomically update both keyring fields before restarting:

1. Set the prior entry to `active: true` and remove its `verifyUntil`.
2. Set the attempted new entry to `active: false` and give it a finite cutoff
   no earlier than the current time plus the configured token lifetime and
   24-hour safety buffer.
3. Set `IOS_API_JWT_ACTIVE_KID` to the prior key id.

Validate the resulting environment with `validateIosJwtConfiguration`, then
restart once. Changing only `IOS_API_JWT_ACTIVE_KID` is invalid because it
conflicts with the keyring's active marker. Do not delete the attempted new key
until its cutoff passes; tokens issued during the attempted rotation must keep
verifying through their expiry window. Re-run old/new REST and WebSocket token
smokes after rollback.
