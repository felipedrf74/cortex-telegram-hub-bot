# Content Engine Security Boundary

The Python content engine is an internal sidecar. It must not be exposed as a
public API.

## Inbound Auth

Every route except `GET /health` requires the shared internal secret:

```http
X-Internal-Secret: $INTERNAL_API_SECRET
```

Requests with a missing or wrong secret return:

```json
{"error":{"code":"UNAUTHORIZED","message":"Unauthorized"}}
```

`/health` stays unauthenticated so deploy scripts and process monitors can
check that the sidecar is alive without holding service credentials.

## Startup Requirement

When `ENV=production`, the content engine refuses to start unless
`INTERNAL_API_SECRET` is set. Local fixture mode may start without live provider
keys, but protected routes still require the internal secret for any caller.

## Caller Contract

The TypeScript backend is the only supported caller. It forwards the same
`INTERNAL_API_SECRET` used for `/api/v1/internal/*` and also forwards
`X-Request-Id` so logs can be joined across both services.

