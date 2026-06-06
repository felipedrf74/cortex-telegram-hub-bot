# Content Engine

Status: canonical
Owner: content lead
Last verified: 2026-05-06
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
