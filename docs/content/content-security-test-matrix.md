# Content Creation Security Test Matrix

Updated: 2026-04-29

## Tests Added Or Updated

| Area | Test Evidence | Result |
|---|---|---|
| Tenant A cannot use Tenant B books | `__tests__/services/content-tenant-scope.test.ts` | PASS |
| Tenant A cannot use Tenant B links | `__tests__/services/content-tenant-scope.test.ts` | PASS |
| Tenant A cannot use Tenant B channels | `__tests__/services/content-tenant-scope.test.ts` | PASS |
| Voice profile not mixed across tenants | `__tests__/services/content-tenant-scope.test.ts` | PASS |
| Extracted channel patterns scoped before prompt use | `__tests__/services/content-tenant-scope.test.ts` | PASS |
| Radar preferences scoped | `__tests__/services/content-tenant-scope.test.ts` | PASS |
| Prompt context excludes unauthorized references | `__tests__/services/content-tenant-scope.test.ts` | PASS |
| Legacy ambiguous references quarantined | `__tests__/services/content-tenant-scope.test.ts` | PASS |
| Content reference routes enforce backend scope | `__tests__/api/content-reference-routes.test.ts` | PASS |
| Content learning routes enforce ownership/scope | `__tests__/api/content-learning-routes.test.ts` | PASS |
| Script route still forwards scoped Voice DNA | `__tests__/api/content-script-duration.test.ts` | PASS |
| Dedup checks remain scoped and provider-routed | `__tests__/services/content-dedup-routing.test.ts` | PASS |
| Curated platform channel synthesis excludes user-private rows | `__tests__/services/channel-learner-scope.test.ts` | PASS |

## Commands Run

```bash
node - <<'NODE'
const fs=require('fs'); const path=require('path'); const Database=require('better-sqlite3');
const db=new Database(':memory:');
const dir=path.resolve('migrations');
for (const f of fs.readdirSync(dir).filter(f=>f.endsWith('.sql')).sort()) db.exec(fs.readFileSync(path.join(dir,f),'utf8'));
console.log('migrations-ok');
NODE
```

Result: PASS

```bash
npm test -- --run __tests__/services/content-tenant-scope.test.ts __tests__/api/content-reference-routes.test.ts __tests__/api/content-learning-routes.test.ts __tests__/services/content-workflow-user-scope.test.ts __tests__/services/content-dedup-routing.test.ts __tests__/api/content-script-duration.test.ts
```

Result: PASS, 6 files / 34 tests

```bash
npm test -- --run __tests__/services/content-tenant-scope.test.ts __tests__/api/content-reference-routes.test.ts __tests__/api/content-learning-routes.test.ts __tests__/services/content-workflow-user-scope.test.ts __tests__/services/content-dedup-routing.test.ts __tests__/api/content-script-duration.test.ts __tests__/services/channel-learner-scope.test.ts __tests__/services/content-radar-preferences.test.ts
```

Result: PASS, 8 files / 37 tests

```bash
npm test -- --run __tests__/api/content-home-route.test.ts __tests__/api/content-reference-routes.test.ts __tests__/api/content-learning-routes.test.ts __tests__/api/internal-routes.test.ts __tests__/services/content-workflow-user-scope.test.ts __tests__/services/content-dedup-routing.test.ts __tests__/services/content-tenant-scope.test.ts __tests__/services/python-engine-hardening.test.ts
```

Result: PASS, 8 files / 93 tests

```bash
npm test -- --run __tests__/api/content-home-route.test.ts __tests__/api/content-reference-routes.test.ts __tests__/api/content-learning-routes.test.ts __tests__/api/internal-routes.test.ts __tests__/services/content-workflow-user-scope.test.ts __tests__/services/content-dedup-routing.test.ts __tests__/services/content-tenant-scope.test.ts __tests__/services/python-engine-hardening.test.ts __tests__/api/content-script-duration.test.ts __tests__/api/content-script-quota.test.ts __tests__/api/content-script-route-utils.test.ts __tests__/services/script-pipeline.test.ts __tests__/api/chat-routes.test.ts
```

Result: PASS, 13 files / 177 tests

```bash
npx tsc --noEmit --pretty false
```

Result: PASS

## Release-Gate Verdict

PASS WITH CONDITIONS: the core backend tenant/privacy controls for Content references, Voice DNA, radar preferences, scripts, learned patterns, and prompt reference assembly are implemented and tested. Broader tenant-admin/support visibility and vector backend namespace proof remain open.
