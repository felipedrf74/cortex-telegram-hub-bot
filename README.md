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
truth is the root-host receipt and state evidence defined in
`docs/release/continuous-deployment.md`; the checked-in
`docs/release/release-state.json` is a non-authoritative projection. Operator
commands are in `ops/nexus-release/README.md`.

## Verification

```bash
npm run test:changed -- --base origin/main
npm run test:full
npm run docs:audit
```

Protected-main selected CI is the production publication gate. The complete
deterministic suite is sharded and available for deliberate manual diagnosis;
it is not a separate release checkpoint. Evaluation corpora run separately
from correctness gates. Generated profiles, inventories, smoke evidence,
reward runs, and release manifests belong under ignored `.local/` paths or CI
artifacts.

Read `AGENTS.md` before making changes. Manual production mutation or
provisioning, TestFlight expiry, and remote branch deletion require explicit
owner authorization. The governed signed-container path deploys automatically
after protected-main CI and does not require a second per-release approval.
