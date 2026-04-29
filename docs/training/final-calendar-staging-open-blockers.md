# Final Calendar Staging Open Blockers

Updated: 2026-04-28

## Summary

The prior P0 blockers for real Google and Outlook staging calendar lifecycle proof are **closed**.

Both providers passed real staging create/read-back/update/same-shape regenerate/changed-shape replace/cancel/retry/cleanup flows with explicit staging-only live-write guardrails.

## Closed Blockers

| ID | Severity | Provider / Layer | Previous blocker | Closure evidence |
| --- | --- | --- | --- | --- |
| CAL-P0-01 | P0 | Global staging | No staging mode configured. | Closed: run used `STAGING=true` and `NODE_ENV=staging`. |
| CAL-P0-02 | P0 | Global staging | Missing explicit write guardrails. | Closed: run used `TRAINING_CALENDAR_STAGING_SMOKE=1` and `TRAINING_CALENDAR_STAGING_ALLOW_LIVE_WRITES=1`. |
| CAL-P0-03 | P0 | Internal agenda / OAuth | Missing staging user ID. | Closed: staging user `1` used for both providers. |
| CAL-P0-04 | P0 | Internal agenda DB | Missing staging DB path. | Closed: server-side staging `.env` supplied `/home/dominguez/telegram-hub-bot-staging/data/bot.db`. |
| CAL-P0-05 | P0 | OAuth security | Missing OAuth encryption key. | Closed: key remained on staging server; tokens decrypted successfully. |
| CAL-P0-06 | P0 | Google Calendar | Missing Google credentials/read-back proof. | Closed: Google run `training-calendar-smoke-20260428165035-7ljwng` passed. |
| CAL-P0-07 | P0 | Outlook Calendar | Missing Outlook credentials/read-back proof. | Closed: Outlook run `training-calendar-smoke-20260428165107-7fsbbr` passed. |
| CAL-P0-08 | P0 | Provider read-back | No provider read-back evidence. | Closed: both providers read back created/updated/replacement events. |
| CAL-P0-09 | P0 | Cleanup proof | No real cleanup proof. | Closed: cleanup failures were `None` for both provider runs. |

## Remaining Calendar Notes

- No open P0/P1 calendar staging blocker remains from this gate.
- Provider smoke results are recorded in `docs/training/final-calendar-staging-results.md`.
- The unified read-back path emits Outlook token-refresh warnings when Outlook is connected, even during Google-only smoke. This is a noisy observability issue, not a lifecycle blocker.

## Verdict

Calendar staging gate: **closed / pass**.
