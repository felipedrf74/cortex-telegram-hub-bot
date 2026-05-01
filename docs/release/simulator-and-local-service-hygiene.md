# Simulator And Local Service Hygiene

Date: 2026-05-01

## Simulator Standard

Before any iOS UI validation:

```bash
xcrun simctl shutdown all
osascript -e 'tell application "Simulator" to quit' || true
xcrun simctl list devices booted
```

Select exactly one simulator by UDID, then use:

```bash
-destination "id=$SELECTED_UDID" \
-parallel-testing-enabled NO \
-maximum-concurrent-test-simulator-destinations 1
```

Do not use name-only destinations for UI validation. Name-only destinations have already caused clone/focus confusion and unreliable evidence.

## Local Service Standard

Before local backend/portal smoke:

```bash
lsof -i :8200
lsof -i :8326
ps aux | grep -i nexus
ps aux | grep -i cooking
ps aux | grep -i training
```

Use fixture mode by default:

```bash
NEXUS_LOCAL_ALLOW_MODEL_CALLS=0
```

After smoke:

```bash
lsof -i :8200
lsof -i :8326
find . -name 'cooking-*.db' -print
xcrun simctl list devices booted
```

## Release Evidence Requirement

Every iOS/frontend smoke report must include:

- selected simulator name/runtime/UDID;
- proof only one simulator was booted;
- exact xcodebuild destination;
- screenshots or UI-test assertions that prove real content, not just launch;
- cleanup status.

Every local backend smoke report must include:

- ports used;
- DB path;
- provider-call mode;
- commands run;
- cleanup status;
- artifacts left behind, if any.
