# GPT-5.5 Local Resource Control

## Policy

Local full-product smoke must preserve the engine's high-intelligence design
without burning model budget unnecessarily.

Use:

- deterministic fixtures for UI/DTO/rendering smoke
- seeded local state for orchestration smoke
- limited real model calls only for explicit coach-quality checks

## Runner Defaults

`scripts/full-nexus-local-engine.sh` blanks:

```bash
OPENAI_API_KEY
GEMINI_API_KEY
ANTHROPIC_API_KEY
ANTHROPIC_ENABLED
```

unless:

```bash
NEXUS_LOCAL_ALLOW_MODEL_CALLS=1
```

is set.

## Required Logging When Model Calls Are Enabled

Record:

- branch and commit
- command
- scenario/persona
- provider/model config used
- number of calls if available
- latency/cost notes
- shutdown confirmation

in `docs/local/gpt55-smoke-test-usage-notes.md`.

## Runaway Detection

After model-enabled smoke:

```bash
scripts/full-nexus-local-engine.sh stop
ps aux | rg 'dist/index.js|content-engine/main.py|node .*training|python .*content-engine'
lsof -nP -iTCP:8200 -sTCP:LISTEN
```
