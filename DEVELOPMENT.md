# Development Best Practices & CI/CD Process

> Status: decommissioned as the live workflow source.
>
> Why: this file still describes a branch/CI model that conflicts with the
> current single-branch, manual promote-to-prod workflow documented elsewhere.
>
> Use these instead:
> - `/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot/CLAUDE.md`
> - `/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot/DEPLOY.md`
> - `/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot/STAGING.md`
> - `/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot/docs/DOCUMENTATION-MAP.md`

> **nexus-hub** — Development workflow, release process, and Claude Code conventions.
> Owner: Felipe Dominguez | Last updated: 2026-03-10

---

## 1. Branch Strategy

### Branching Model

Use a **trunk-based** approach with short-lived feature branches off `main`:

```
main              ← always deployable, tagged releases
 ├─ feat/xxx      ← new features
 ├─ fix/xxx       ← bug fixes
 ├─ chore/xxx     ← refactors, deps, configs
 └─ hotfix/xxx    ← urgent production fixes (merge directly)
```

### Branch Naming Convention

```
<type>/<short-description>

feat/unified-image-classifier
fix/calendar-category-fallback
chore/upgrade-grammy-v2
hotfix/crash-on-empty-tool-result
```

### Rules

- **Never commit directly to `main`** — always use a branch + PR (even solo).
- Keep branches short-lived (< 3 days). Longer work should be broken into incremental PRs.
- Delete branches after merge.
- `main` must always compile (`tsc`) and pass lint.

---

## 2. Commit Conventions

### Format: Conventional Commits

```
<type>(<scope>): <description>

[optional body]

[optional footer]
```

**Types:** `feat`, `fix`, `chore`, `refactor`, `docs`, `test`, `perf`, `ci`

**Scopes** (match your project structure):
- `bot` — command handlers, message routing
- `secretary` / `triathlon` / `content` — domain-specific changes
- `todo` / `calendar` / `mail` — service integrations
- `invoice` — invoice filing, collection, browser automation
- `state` — SQLite state modules
- `config` — environment, build config
- `docker` — container setup
- `scheduler` — cron jobs

### Examples

```
feat(invoice): add custom vendor registration via /addfatura
fix(calendar): handle truncated JSON from max_tokens cutoff
refactor(bot): extract handleInvoiceFiling from inline photo handler
chore(deps): upgrade @anthropic-ai/sdk to 0.80.0
perf(todo): cache list metadata with 5-minute TTL
ci: add GitHub Actions build + lint pipeline
```

### Rules

- One logical change per commit.
- Write the subject in imperative mood ("add", "fix", "remove" — not "added" or "fixes").
- Reference issue numbers in the footer when applicable: `Closes #12`.

---

## 3. Claude Code Workflow

### CLAUDE.md Project Instructions

Create a `CLAUDE.md` at the project root. Claude Code reads this automatically for context:

```markdown
# CLAUDE.md — nexus-hub

## Project
TypeScript Telegram bot. Personal command center with multi-domain AI routing.

## Build & Run
- `npm run build` — compile TypeScript to /dist/
- `npm start` — run production
- `npm run dev` — tsc watch mode
- `npm run lint` — ESLint check
- `npm run lint:fix` — auto-fix lint issues
- `npm test` — run vitest

## Architecture
- src/bot.ts — Telegram handlers (~2400 lines, be careful with large edits)
- src/domains/ — Secretary, Triathlon, Content domain handlers
- src/services/ — Microsoft, Google, Anthropic, scheduler integrations
- src/state/ — SQLite-backed state modules
- src/router/ — Three-tier message classification

## Conventions
- Conventional Commits: feat(scope): description
- Always run `npm run build` after changes to verify compilation
- Always run `npm run lint` before committing
- Never modify .env — use .env.example for new variables
- All dates use Luxon with Europe/Lisbon timezone
- Telegram messages use HTML parse mode (escape with telegramFormatter)
- Error handling: always catch and log, send user-friendly Telegram message
- Tool results truncated at 2000 chars in Anthropic API calls

## Testing
- Run `npm test` after any logic change
- Test files: src/**/*.test.ts (colocated)

## Do NOT
- Commit .env, data/, logs/, or dist/
- Use execSync with string interpolation (shell injection risk)
- Add dependencies without checking bundle size impact
- Change database schema without a migration file in /migrations/
```

### Claude Code Session Workflow

When starting a development session with Claude Code:

1. **State the intent clearly** — "I want to add X feature" or "Fix Y bug".
2. **Let Claude read the relevant files first** — don't rush to code.
3. **Ask Claude to build and lint after changes** — `npm run build && npm run lint`.
4. **Review the diff before committing** — `git diff --stat` then `git diff`.
5. **Ask Claude to commit with conventional format** — "commit this as feat(scope): description".

### Pre-Commit Checklist (enforce in Claude Code)

Before every commit, Claude Code should verify:

```bash
npm run build          # TypeScript compiles cleanly
npm run lint           # No lint errors
npm test               # Tests pass (when tests exist)
git diff --stat        # Review changed files make sense
```

---

## 4. Code Quality Setup

### 4.1 Add ESLint

```bash
npm install -D eslint @typescript-eslint/eslint-plugin @typescript-eslint/parser
```

**eslint.config.mjs:**

```javascript
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';

export default [
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: './tsconfig.json',
      },
    },
    plugins: { '@typescript-eslint': tsPlugin },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-floating-promises': 'error',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'eqeqeq': 'error',
    },
  },
  { ignores: ['dist/', 'node_modules/', 'scripts/'] },
];
```

**Add to package.json scripts:**

```json
"lint": "eslint src/",
"lint:fix": "eslint src/ --fix"
```

### 4.2 Add Testing Framework

```bash
npm install -D vitest
```

**vitest.config.ts:**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    coverage: { reporter: ['text', 'lcov'] },
  },
});
```

**Add to package.json scripts:**

```json
"test": "vitest run",
"test:watch": "vitest"
```

### What to Test (priority order)

1. **Router logic** — classification patterns, keyword matching
2. **Date parser** — natural language parsing edge cases
3. **Telegram formatter** — HTML escaping, message splitting
4. **State modules** — CRUD operations on SQLite
5. **Invoice extraction** — JSON parsing, confidence thresholds
6. **Config validation** — missing env vars, malformed values

Unit tests should be colocated: `src/utils/date-parser.test.ts` next to `date-parser.ts`.

---

## 5. CI/CD Pipeline — GitHub Actions

### 5.1 CI: Build + Lint + Test on Every Push

**.github/workflows/ci.yml:**

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: 'npm'

      - run: npm ci

      - name: Lint
        run: npm run lint

      - name: Build
        run: npm run build

      - name: Test
        run: npm test
```

### 5.2 CD: Deploy on Release Tag

**.github/workflows/deploy.yml:**

```yaml
name: Deploy

on:
  push:
    tags: ['v*']

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: 'npm'

      - run: npm ci
      - run: npm run build
      - run: npm test

      - name: Build Docker image
        run: |
          docker build -f docker/Dockerfile -t nexus-hub:${{ github.ref_name }} .
          docker tag nexus-hub:${{ github.ref_name }} nexus-hub:latest

      - name: Deploy to server
        env:
          DEPLOY_HOST: ${{ secrets.DEPLOY_HOST }}
          DEPLOY_USER: ${{ secrets.DEPLOY_USER }}
          DEPLOY_KEY: ${{ secrets.DEPLOY_SSH_KEY }}
          DEPLOY_PATH: ${{ secrets.DEPLOY_PATH }}
        run: |
          mkdir -p ~/.ssh
          echo "$DEPLOY_KEY" > ~/.ssh/deploy_key
          chmod 600 ~/.ssh/deploy_key
          rsync -avz --exclude-from='.rsyncignore' \
            -e "ssh -i ~/.ssh/deploy_key -o StrictHostKeyChecking=accept-new" \
            . ${DEPLOY_USER}@${DEPLOY_HOST}:${DEPLOY_PATH}/
          ssh -i ~/.ssh/deploy_key ${DEPLOY_USER}@${DEPLOY_HOST} \
            "cd ${DEPLOY_PATH} && npm ci --production && pm2 restart ecosystem.config.js"
```

> **Note:** If you prefer Docker-based deploys, replace the rsync step with docker push to a registry + docker pull on the server.

### 5.3 GitHub Actions Secrets to Configure

| Secret | Purpose |
|--------|---------|
| `DEPLOY_HOST` | Server IP or hostname |
| `DEPLOY_USER` | SSH username |
| `DEPLOY_SSH_KEY` | Private key for deployment |
| `DEPLOY_PATH` | Remote path (e.g., `/opt/nexus-hub`) |

---

## 6. Release Process

### Versioning: Semantic Versioning

```
MAJOR.MINOR.PATCH

1.10.0 — new feature (backward compatible)
1.10.1 — bug fix
2.0.0  — breaking change (schema migration, API change)
```

### Release Checklist

```
1. Ensure main is green (CI passes)
2. Update CHANGELOG.md with the new version section
3. Update version in package.json
4. Commit: `chore: release v1.10.0`
5. Tag: `git tag v1.10.0`
6. Push: `git push origin main --tags`
7. GitHub Actions deploys automatically on tag push
8. Verify bot is running: send /status in Telegram
```

### Release with Claude Code

Ask Claude Code to handle the release:

> "Prepare release v1.10.0. Update CHANGELOG with the changes since last release, bump package.json version, commit and tag."

### Hotfix Process

For urgent production fixes:

```
1. Branch from main: hotfix/description
2. Fix, build, test locally
3. PR → merge to main
4. Tag immediately: git tag v1.9.1
5. Push tag to trigger deploy
```

---

## 7. Database Migration Process

Every schema change MUST go through a migration file.

### Migration Convention

```
migrations/
  001_initial_schema.sql
  002_shared_memory.sql
  003_reminders.sql
  004_invoice_tables.sql
  005_saved_ideas.sql
  006_next_change.sql        ← new
```

### Rules

- **Never modify an existing migration** — always create a new one.
- **Migrations must be idempotent** — use `CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`.
- **Test migrations on a fresh database** — delete `data/bot.db` and restart to verify all migrations apply cleanly.
- **Include rollback notes** as SQL comments at the bottom of the file (in case manual revert is needed).

### Template

```sql
-- Migration 006: Add <description>
-- Date: 2026-03-10

CREATE TABLE IF NOT EXISTS new_table (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ...
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Rollback: DROP TABLE IF EXISTS new_table;
```

---

## 8. Dependency Management

### Rules

- **Pin major versions** in package.json (use `^` for minor/patch auto-updates).
- **Run `npm audit`** monthly and before releases.
- **Check bundle impact** before adding new dependencies: `npm install --dry-run <pkg>`.
- **Update Playwright** carefully — browser automation is sensitive to version changes. Test Amazon/Uber flows after upgrades.
- **Anthropic SDK updates** — check for breaking changes in tool-use API format.

### Update Process

```bash
# Check for outdated packages
npm outdated

# Update non-breaking
npm update

# For major version bumps, update one at a time and test:
npm install grammy@latest
npm run build && npm test
```

---

## 9. Environment Management

### .env Discipline

- **Never commit `.env`** — it's in .gitignore.
- **Always update `.env.example`** when adding new environment variables.
- **Document each variable** with a comment in `.env.example`.
- **Use sensible defaults in `config.ts`** — the app should start (in degraded mode) even with minimal config.

### Environment Tiers

| Tier | Purpose | Config Source |
|------|---------|---------------|
| Local Dev | Feature development | `.env` (local file) |
| Production | Live bot | `.env` on server or Docker env_file |

---

## 10. Monitoring & Observability

### Current: PM2 + Pino Logs

```bash
# Live logs
pm2 logs nexus-hub

# Status
pm2 status

# Restart
pm2 restart nexus-hub
```

### Recommended Additions

1. **Health check endpoint** — Add a `/status` response time to the scheduler log (every 5 min) as a heartbeat.
2. **Error alerting** — Send critical errors to a dedicated Telegram chat/channel (separate from the main bot conversation). Log pattern: `logger.fatal({ err, context })`.
3. **Uptime tracking** — PM2 `pm2-logrotate` module + `pm2 save` for persistence across server reboots.
4. **API cost tracking** — Log Anthropic API usage (input/output tokens) per call. Aggregate daily in the /status command output.

---

## 11. Security Checklist

Run before every release:

- [ ] No credentials in code (grep for API keys, tokens, passwords)
- [ ] `.env` is in `.gitignore`
- [ ] `TELEGRAM_ALLOWED_USER_IDS` is set (no open access)
- [ ] `execFileSync` used instead of `execSync` for shell commands
- [ ] SSH uses `StrictHostKeyChecking=accept-new`
- [ ] `npm audit` shows no critical vulnerabilities
- [ ] Playwright sessions don't store passwords (only session cookies)
- [ ] Tool result truncation is enforced (prevent prompt injection via large payloads)

---

## 12. Quick Reference — Full Workflow

```
┌─────────────────────────────────────────────────────────┐
│                    DEVELOPMENT CYCLE                     │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  1. Branch       git checkout -b feat/my-feature        │
│                                                         │
│  2. Develop      (with Claude Code — reference CLAUDE.md)│
│                                                         │
│  3. Verify       npm run build && npm run lint           │
│                  npm test                                │
│                                                         │
│  4. Commit       git add -p (review hunks)              │
│                  git commit -m "feat(scope): ..."        │
│                                                         │
│  5. Push         git push -u origin feat/my-feature     │
│                                                         │
│  6. PR           Create PR on GitHub                    │
│                  CI runs automatically (build+lint+test) │
│                                                         │
│  7. Merge        Squash-merge to main                   │
│                  Delete branch                          │
│                                                         │
│  8. Release      Update CHANGELOG + package.json        │
│  (when ready)    git tag v1.X.0 && git push --tags      │
│                  CD deploys automatically                │
│                                                         │
│  9. Verify       /status in Telegram                    │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

---

## 13. Files to Create / Modify

To implement everything above, these are the concrete changes needed:

| Action | File | Priority |
|--------|------|----------|
| Create | `CLAUDE.md` | **Now** |
| Create | `eslint.config.mjs` | **Now** |
| Create | `vitest.config.ts` | **Now** |
| Create | `.github/workflows/ci.yml` | **Now** |
| Create | `.github/workflows/deploy.yml` | After CI works |
| Modify | `package.json` (add lint, test scripts + devDeps) | **Now** |
| Modify | `.gitignore` (add coverage/) | **Now** |
| Create | `src/utils/date-parser.test.ts` | First test |
| Create | `src/router/router.test.ts` | Second test |
| Modify | `.env.example` (add comments for each var) | Next session |
