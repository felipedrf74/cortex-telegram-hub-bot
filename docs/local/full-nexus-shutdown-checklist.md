# Full Nexus Shutdown Checklist

1. Stop runner-owned processes:

```bash
scripts/full-nexus-local-engine.sh stop
```

2. Verify backend port:

```bash
lsof -nP -iTCP:8200 -sTCP:LISTEN || true
```

3. Verify optional content-engine port:

```bash
lsof -nP -iTCP:8102 -sTCP:LISTEN || true
```

4. Verify no long-running smoke/model processes:

```bash
ps aux | rg 'dist/index.js|content-engine/main.py|training-calendar-staging-smoke|training-cross-skill-staging-smoke|full-nexus' -n || true
```

5. Remove local auth artifacts if desired:

```bash
scripts/full-nexus-local-engine.sh cleanup
```

6. Reset local DB only when intentional:

```bash
FULL_NEXUS_RESET_DB=1 scripts/full-nexus-local-engine.sh cleanup
```
