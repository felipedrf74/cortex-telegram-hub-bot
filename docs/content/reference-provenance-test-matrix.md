# Reference Provenance Test Matrix

Updated: 2026-04-29

## Tests Added Or Updated

| Requirement | Test Evidence | Result |
|---|---|---|
| Tenant-safe reference retrieval | `__tests__/services/content-reference-provenance.test.ts` | PASS |
| Book reference used correctly | `__tests__/services/content-reference-provenance.test.ts` | PASS |
| Channel reference used correctly | `__tests__/services/content-reference-provenance.test.ts` | PASS |
| Link reference used correctly | `__tests__/services/content-reference-provenance.test.ts` | PASS |
| Broken link not used silently | `__tests__/services/content-reference-provenance.test.ts` | PASS |
| Hallucinated reference rejected | `__tests__/services/content-reference-provenance.test.ts` | PASS |
| Claim without source flagged | `__tests__/services/content-reference-provenance.test.ts` | PASS |
| Source attribution attached to generated output | `__tests__/services/content-reference-provenance.test.ts` | PASS |
| Provenance preserved through output provenance record | `__tests__/services/content-reference-provenance.test.ts` | PASS |
| Reference from another tenant rejected | `__tests__/services/content-reference-provenance.test.ts` | PASS |

## Commands Run

```bash
npm test -- --run __tests__/services/content-reference-provenance.test.ts
```

Result: PASS, 1 file / 4 tests

```bash
npm test -- --run __tests__/services/content-reference-provenance.test.ts __tests__/services/content-domain-ontology.test.ts __tests__/services/content-tenant-scope.test.ts __tests__/api/content-reference-routes.test.ts __tests__/api/content-learning-routes.test.ts __tests__/services/content-dedup-routing.test.ts __tests__/services/channel-learner-scope.test.ts __tests__/services/content-radar-preferences.test.ts
```

Result: PASS, 8 files / 37 tests

```bash
npx tsc --noEmit --pretty false
```

Result: PASS

```bash
node - <<'NODE'
const fs=require('fs'); const path=require('path'); const Database=require('better-sqlite3');
const db=new Database(':memory:');
const dir=path.resolve('migrations');
for (const f of fs.readdirSync(dir).filter(f=>f.endsWith('.sql')).sort()) {
  db.exec(fs.readFileSync(path.join(dir,f),'utf8'));
}
console.log('migrations-ok');
NODE
```

Result: PASS

## Release Gate

Verdict: PASS WITH CONDITIONS

The backend provenance foundation is implemented and tested. It is not a claim that every generation/refinement path already records provenance, nor that iOS/portal now render attribution.
