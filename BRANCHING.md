# Nexus Hub — Git Branching & Release Strategy

## Branch Structure

```
main ─────────────────────────────────────────────────► (production)
  │                                                      
  ├── develop ────────────────────────────────────────► (staging/QA)
  │     │                                                
  │     ├── feature/NH-001-aiprovider-abstraction        
  │     ├── feature/NH-002-message-adapter               
  │     ├── feature/NH-003-vitest-setup                  
  │     └── feature/NH-004-stripe-billing                
  │                                                      
  ├── hotfix/fix-garmin-auth-crash                       
  └── release/v5.0.0                                     
```

## Branch Rules

| Branch | Purpose | Merges Into | Protection |
|--------|---------|-------------|------------|
| `main` | Production-ready code | — | Required: CI pass, 1 review (self-review OK for solo) |
| `develop` | Integration/QA branch | `main` (via release) | Required: CI pass |
| `feature/*` | New features | `develop` | CI must pass |
| `hotfix/*` | Critical production fixes | `main` + `develop` | CI must pass |
| `release/*` | Release preparation | `main` + `develop` | CI must pass, version bumped |

## Workflow

### Normal Feature Development
```bash
# 1. Create feature branch from develop
git checkout develop
git pull origin develop
git checkout -b feature/NH-001-aiprovider-abstraction

# 2. Work on feature (commit often)
git add .
git commit -m "feat(core): add AIProvider interface"

# 3. Push and create PR to develop
git push origin feature/NH-001-aiprovider-abstraction
# → GitHub PR: feature/NH-001 → develop
# → CI runs automatically
# → Review + merge when green

# 4. After merge, delete feature branch
git branch -d feature/NH-001-aiprovider-abstraction
```

### Creating a Release
```bash
# 1. Create release branch from develop
git checkout develop
git pull origin develop
git checkout -b release/v5.0.0

# 2. Bump version, update changelog
npm version 5.0.0 --no-git-tag-version
# Update CHANGELOG.md

# 3. PR to main
git push origin release/v5.0.0
# → GitHub PR: release/v5.0.0 → main
# → CI runs, full test suite
# → Merge triggers CD pipeline → production deploy

# 4. Tag is created by GitHub Actions release workflow
# 5. Merge main back to develop
git checkout develop
git merge main
git push origin develop
```

### Hotfix (Critical Production Bug)
```bash
# 1. Branch from main (production)
git checkout main
git pull origin main
git checkout -b hotfix/fix-garmin-auth-crash

# 2. Fix the bug
git commit -m "fix(garmin): prevent MFA storm on concurrent 403s"

# 3. PR to main (fast-track, skip develop)
git push origin hotfix/fix-garmin-auth-crash
# → PR to main, CI runs, deploy on merge

# 4. Also merge to develop
git checkout develop
git merge hotfix/fix-garmin-auth-crash
git push origin develop
```

## Commit Convention

Format: `type(scope): description`

| Type | When |
|------|------|
| `feat` | New feature |
| `fix` | Bug fix |
| `refactor` | Code change that neither fixes nor adds |
| `test` | Adding or updating tests |
| `docs` | Documentation only |
| `ci` | CI/CD pipeline changes |
| `chore` | Maintenance (deps, config) |
| `perf` | Performance improvement |
| `style` | Code style (formatting, no logic change) |

Examples:
```
feat(core): add AIProvider interface with Claude/GPT/Gemini support
fix(router): handle empty message in keyword match
test(classifier): add PT-BR keyword matching tests
ci(github): add production deploy workflow with rollback
docs(readme): update setup instructions for Nexus Hub
refactor(services): extract StorageProvider from direct SQLite calls
```

## Notion Integration

Every release and deploy creates a record in the **Nexus Hub — Releases** Notion database with:
- Version number
- Deploy status (✅ Success / ❌ Failed)
- Type (Release / Deploy / Rollback / Hotfix)
- Date
- Commit SHA
- Release notes

## Environment Mapping

| Branch | Environment | Server | Auto-Deploy |
|--------|-------------|--------|-------------|
| `main` | Production | serverdominguez | ✅ On merge |
| `develop` | Staging/QA | (same server, future: separate) | Manual |
| `feature/*` | Local dev | localhost | — |
