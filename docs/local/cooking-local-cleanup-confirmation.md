# Cooking Local Cleanup Confirmation

Date: 2026-04-30

Full local backend smoke was started in attached mode on `127.0.0.1:8326`.

Cleanup performed:

- Stopped attached backend process `7750`.
- Verified no listener remained on TCP port `8326`.
- Removed local smoke DB `data/cooking-full-nexus-smoke.db` and sidecar files.
- Removed local smoke auth token through the runner cleanup path.
- No content-engine sidecar, tunnel, iOS simulator session, or real provider-call loop was started.

Cleanup status: PASS.

## Rich iOS/Portal Addendum Cleanup

The rich Cooking simulator and portal runtime smoke was started in attached
mode on `127.0.0.1:8200`.

Cleanup performed:

- Confirmed the simulator app had already terminated; `simctl` found no
  running `me.nexushub.app` process to stop.
- Stopped attached backend process `43374` with `SIGTERM`.
- Verified no listener remained on TCP port `8200`.
- Removed local smoke DB `data/cooking-ios-rich-smoke.db` and sidecar files
  through the runner cleanup path.
- No content-engine sidecar, tunnel, production calendar, or real
  provider-call loop was started.

Rich addendum cleanup status: PASS.
