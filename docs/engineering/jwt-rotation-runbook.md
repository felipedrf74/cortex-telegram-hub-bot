# iOS JWT Rotation Runbook

Status: canonical
Owner: backend security lead (Felipe)
Last verified: 2026-05-06
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

1. Run the helper locally:

```bash
npx tsx scripts/rotate-jwt-signing-key.ts --rotation-hours=24
```

2. Store the emitted `IOS_API_JWT_KEYS` and `IOS_API_JWT_ACTIVE_KID` values in
   the deployment environment.
3. Restart the API process.
4. Confirm `/api/v1/auth/me` accepts a freshly-issued token and an old-token
   smoke token from before the restart.
5. After the rotation window has elapsed, remove expired key entries from
   `IOS_API_JWT_KEYS`.

## Rollback

Set `IOS_API_JWT_ACTIVE_KID` back to the prior key id while leaving both keys in
`IOS_API_JWT_KEYS`. Restart the API process. Do not delete the new key until the
incident is closed; tokens issued during the attempted rotation need to keep
verifying through their expiry window.
