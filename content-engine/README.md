# Content Engine

Status: canonical
Owner: content lead
Last verified: 2026-08-10
Update policy: update when the Python content-engine test harness, routing, or local setup changes.

Python FastAPI service for content discovery, creative generation, and content intelligence. Runtime source semantics stay owned by the TypeScript backend contract; Python unit tests focus on prompt safety, degraded-mode behavior, and scoped request threading.

## Local Tests

```bash
cd engine/content-engine
python -m pip install -r requirements.txt -r requirements-dev.txt
python -m pytest tests/ -v
```

On Felipe's local machine the project venv is `.venv313`, so the known-good command is:

```bash
cd engine/content-engine
.venv313/bin/python -m pytest tests/ -v
```

## Test Fixtures

Shared fixtures live in `tests/conftest.py`:

- `neutral_creator_profile`: a founder-neutral profile string for prompt tests.
- `assert_no_founder_identity`: guards against Felipe/Jaqueline/nexushubbot identity leakage in prompts and outputs.

New tests should avoid live network/model calls. Patch `ask_claude_json`, HTTPX clients, and orchestrator fan-out methods per test.

## Release dependency lock

`requirements.txt` is the reviewed direct dependency source for local and test
installs. Production images and the temporary PM2 fallback install only the
generated Python 3.12/linux-amd64 lock with hashes. Generate it with exactly
`uv 0.10.9`; advance the resolver version and package-index cutoff only as an
explicit dependency update. The generator binds the complete source-file
digest, refuses ambient uv/pip policy, and resolves only the pinned public index,
so extras-only drift or local configuration cannot leave an apparently current
lock:

```bash
node scripts/generate-python-release-lock.mjs
```

Commit the source and regenerated lock together. CI verifies that every direct
pin is represented exactly and that pip accepts the complete lock under
`--require-hashes --only-binary=:all:`.

The always-hosted security job bootstraps both `uv` and `pip-audit` from their
separate Linux/x86-64 hash locks. The same generator command regenerates and CI
byte-compares the release and audit-tool locks. Audit tooling is excluded from
both production images and the PM2 runtime dependency artifact.
