# Simulator And Local Service Hygiene

Status: canonical
Owner: release + iOS QA lead (Felipe)
Last verified: 2026-05-14
Update policy: update when simulator UDID pinning, local-service cleanup, or iOS-test hygiene contract changes.

Date: 2026-05-14

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

For full simulator test runs, prefer the iOS repo helper:

```bash
cd "/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub"
scripts/ios-single-simulator-test.sh
```

The helper has an EXIT cleanup trap. By default it terminates the app, shuts
down the selected simulator, shuts down any other booted simulator, quits
Simulator.app, and trims lingering `SimulatorTrampoline`,
`com.apple.CoreSimulator.CoreSimulatorService`, and SwiftUI Preview simulator
processes. This is intentional: after full simulator suites, Activity Monitor
can otherwise attribute several GB of retained simulator runtime memory to
`SimulatorTrampoline`.

Set `IOS_KEEP_SIM_BOOTED=1` or `IOS_TRIM_SIMULATOR_PROCESSES=0` only when the
handoff explicitly needs the simulator left alive for manual inspection.

If a full test run did not use the helper, perform this cleanup before handing
off:

```bash
xcrun simctl shutdown all
osascript -e 'tell application "Simulator" to quit' || true
pkill -f 'Previews/Simulator Devices' 2>/dev/null || true
killall SimulatorTrampoline 2>/dev/null || true
killall com.apple.CoreSimulator.CoreSimulatorService 2>/dev/null || true
xcrun simctl list devices booted
ps -axo pid,rss,comm | rg 'SimulatorTrampoline|CoreSimulatorService|Simulator.app' || true
```

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
