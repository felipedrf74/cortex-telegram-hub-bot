# Chat Quality Operations

Status: current
Owner: Felipe
Last verified: 2026-07-21

One page for operating the production chat-quality loop (M22).

## Surfaces

- Dashboard page: `http://127.0.0.1:8200/chat-quality` (portal admin token;
  JSON at `GET /api/portal/chat-quality`). Aggregate-only payload: eval score
  trend + monthly spend, day-to-day failure-type breakdown, locale leakage
  rate, finalizer quality-gate outcome counters (process-local since boot),
  per-domain routing accuracy from the latest ACCEPTED snapshot, corpus
  labeling progress, ChatV2 readiness rows, and online-eval sampler capture
  counts by status/reason (never raw text).
- Weekly digest: scheduler job `chat_quality_weekly_digest` (Mon 07:30 UTC)
  records ONE info-severity operator alert per week
  (`chat-quality-digest:<date>`) delivered through the existing
  `operator_alert_delivery` webhook path. Kill switch:
  `CHAT_QUALITY_WEEKLY_DIGEST_DISABLED=1`.
- Immediate regressions: parity/fallback readiness regressions
  (legacy-retirement phase gates and `legacy_fallback_rate`) are recorded as
  their own warning/critical operator alerts at digest time — never folded
  into the info digest.
- Readiness input: the dashboard and digest read the artifact at
  `CHAT_V2_READINESS_REPORT_PATH` (default
  `reports/chatv2-readiness/latest.json`); missing/invalid files degrade to
  "readiness unavailable" without failing the page or the job.

## Weekly ritual

1. Read the digest alert (or open `/chat-quality`).
2. Label pending sampler captures at `/routing-corpus` (owner-gated; raw
   utterances are visible only behind the portal admin token).
3. Triage any new day-to-day failure types and sampler reason spikes; file
   fixes against the owning milestone/service.
4. If readiness regressions fired, follow the alert runbook links before any
   ChatV2 phase promotion.

## Owner-gated steps (never automated)

- Corpus labeling passes (`/routing-corpus`).
- `npx tsx scripts/run-routing-accuracy.ts --refresh-llm` (the only networked
  routing-accuracy path).
- `npx tsx scripts/run-routing-accuracy.ts --gate --accept-snapshot`
  (ratchet acceptance).
- Staging/real-provider eval runs (budgeted; persisted via
  `POST /api/portal/eval-history`).
- Refreshing the readiness artifact:
  `npx tsx scripts/chatv2-completion-readiness.ts > reports/chatv2-readiness/latest.json`
  — this is the ONLY producer of the `chat_v2_completion_readiness_report.v1`
  schema the dashboard/digest loader accepts. Do NOT redirect
  `scripts/chatv2-readiness-alerts.ts --json` into the artifact path: its
  output is an alerts report (`chat_v2_readiness_alerts_report.v1`) and the
  loader rejects it, which silently dead-wires the regression alerts.
- Recording the full readiness alert set immediately (separate from the
  artifact refresh): `npx tsx scripts/chatv2-readiness-alerts.ts --write-alerts`.
