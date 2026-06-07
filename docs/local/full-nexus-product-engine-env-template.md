# Full Nexus Product Engine Local Env Template

Copy this into `.env.local-full-nexus` only if you need to override the runner
defaults. Do not put production secrets here.

```bash
# Local-only runtime
NODE_ENV=development
ENV=development
STAGING=false
PORTAL_ENABLED=true
PORTAL_BIND=127.0.0.1
PORTAL_PORT=8200
PORTAL_ALLOW_LOCAL_BYPASS=true
HEALTH_ALLOW_UNAUTHENTICATED=true
DATABASE_PATH=./data/local-full-nexus-smoke.db
TIMEZONE=Europe/Lisbon
LOG_LEVEL=info

# iOS local auth
IOS_API_ENABLED=true
IOS_API_JWT_SECRET=local-full-nexus-ios-jwt-secret-000000000000000000000000000000
IOS_INVITE_CODE=LOCAL-BETA-2026
IOS_OWNER_CODE=LOCAL-OWNER-2026

# Bootstrap and billing
TELEGRAM_ALLOWED_USER_IDS=100000001
OWNER_TELEGRAM_ID=100000001
TELEGRAM_LEGACY_DELIVERY=false
TELEGRAM_BOT_TOKEN=local-full-nexus-telegram-token-disabled
PAYWALL_ENABLED=false

# Local-only encryption and internals
OAUTH_ENCRYPTION_KEY=local-full-nexus-oauth-key-000000000000000000000000000000
FINANCE_ENCRYPTION_ENABLED=false
BACKUP_ENABLED=false
INTERNAL_API_SECRET=local-full-nexus-internal-secret
NEXUS_MULTISKILL_MESH=on

# Local invoice object storage. Production should use self-hosted MinIO on
# the VPS; local smoke uses filesystem storage so photo/receipt filing can
# run without external services.
INVOICE_OBJECT_STORAGE_ENABLED=true
INVOICE_OBJECT_STORAGE_BACKEND=filesystem
INVOICE_OBJECT_STORAGE_DIR=./data/invoice-objects
INVOICE_OBJECT_MAX_BYTES=10485760
INVOICE_OBJECT_MIN_FREE_BYTES=0
INVOICE_OBJECT_TENANT_MAX_BYTES=0

# Model/provider cost control: default smoke should not call providers.
OPENAI_API_KEY=
GEMINI_API_KEY=
ANTHROPIC_API_KEY=
ANTHROPIC_ENABLED=false
AI_CALL_TIMEOUT_MS=15000
GLOBAL_DAILY_COST_LIMIT=1.00

# Optional content engine
CONTENT_ENGINE_ENABLED=false
CONTENT_ENGINE_PORT=8102

# Optional runner toggles
NEXUS_LOCAL_START_CONTENT_ENGINE=0
NEXUS_LOCAL_ALLOW_MODEL_CALLS=0
NEXUS_LOCAL_RUN_AUTH_SMOKE=1
FULL_NEXUS_RESET_DB=0
```
