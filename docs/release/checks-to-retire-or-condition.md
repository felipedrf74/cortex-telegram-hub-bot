# Checks To Retire Or Condition

Date: 2026-05-01

| Priority | Check | Action | Why | Replacement |
| --- | --- | --- | --- | --- |
| P1 | Full backend verify after docs-only commits | Condition | No source behavior can change; high time cost. | `git diff --check`, doc identity check. |
| P1 | Full iOS suite for backend-only changes | Condition | Unrelated to backend-only code unless app contract changed. | Backend focused tests; iOS decoder tests only for contract changes. |
| P1 | Google/Outlook provider smoke on unchanged backend/calendar candidate | Condition | Expensive and can create cleanup risk. | Compare current RC SHA to last provider smoke SHA. |
| P1 | Portal browser smoke when portal files/routes unchanged | Condition | Low signal for backend-only service changes. | Route/service focused tests. |
| P2 | Repeated manual release identity checks in every prompt | Retire | Human copying caused doc drift. | `scripts/release-identity.sh` and future drift checker. |
| P2 | Name-only simulator destinations | Retire for UI evidence | Can open/select clones. | UDID-only destination. |
| P2 | Old superseded QA reports as active evidence | Retire from current gate | Reopens closed/refuted findings. | Current release index with active blockers only. |
| P2 | Generic local smoke and generic staging smoke both treated as equivalent | Clarify | They answer different questions. | Local smoke = development runtime; staging smoke = deployed artifact. |
| P3 | Requiring branch backup/tag for docs-only process docs | Condition | Ceremony without rollback value. | Normal git commit; backup branch for product code or risky docs generated from release artifacts. |
