# Nexus Hub Backend

Nexus Hub is the backend runtime for the iOS-first personal operating system.
It provides tenant-scoped product capabilities, scheduled agents, REST and
portal contracts, the Training catalog, and the Python Content Engine.

## Start locally

```bash
npm ci
npm run build
npm run test:fast
```

Use `docs/project-map.json` for machine-readable navigation and
`docs/DOCS_INDEX.md` for the small set of canonical documents. Current release
truth is `docs/release/release-state.json`; operator commands are in
`docs/release/README.md`.

## Verification

```bash
npm run test:changed -- --base origin/main
npm run test:critical
npm run test:release -- --base origin/main
npm run docs:audit
```

The complete deterministic suite is sharded and reserved for nightly, manual,
and test-infrastructure changes. Evaluation corpora run separately from
correctness gates. Generated profiles, inventories, smoke evidence, reward
runs, and release manifests belong under ignored `.local/` paths or CI
artifacts.

Read `AGENTS.md` before making changes. Production deployment, TestFlight
expiry, and remote branch deletion require explicit owner authorization.
