// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Milestone 22 — chat-quality dashboard (portal).
 *
 * JSON endpoint (admin token, same conventions as eval-history-routes):
 *   GET /api/portal/chat-quality   full aggregated dashboard payload
 *
 * Plus a minimal HTML page at /chat-quality. The page itself carries no
 * data; it asks for the portal admin token and calls the JSON endpoint with
 * a Bearer header (routing-corpus-routes pattern).
 */

import type { Express, Request, Response } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { extractClientIp } from '../api/rate-limiter';
import { requirePortalAdminToken } from '../api/secret-guards';
import { getDb } from '../services/database';
import {
  buildChatQualityDashboard,
  loadChatV2ReadinessReportFromFile,
} from '../services/chat-quality-dashboard';
import { sendPortalInternalError } from './http';

export function registerPortalChatQualityRoutes(app: Express): void {
  const routeRateLimitMiddleware = rateLimit({
    windowMs: 60 * 1000,
    limit: 120,
    keyGenerator: (req: Request) => `ip:${ipKeyGenerator(extractClientIp(req))}`,
    legacyHeaders: false,
    standardHeaders: false,
    handler: (_req, res, _next, options) => {
      const retryAfter = Math.max(1, Math.ceil(options.windowMs / 1000));
      res.setHeader('Retry-After', retryAfter);
      res.status(options.statusCode).json({
        error: { code: 'RATE_LIMITED', message: 'Too many chat-quality requests. Slow down.', retryAfter },
      });
    },
  });

  // AUTH NOTE: requirePortalAdminToken (src/api/secret-guards) with the
  // documented secret-guards caveat that PORTAL_ALLOW_LOCAL_BYPASS=true
  // waives the token for loopback requests (allowLocalPortalBypass), so that
  // bypass must never be enabled where this portal is reachable by anyone
  // but the owner. The payload is aggregate-only (no raw utterance or
  // response text), but readiness/accuracy evidence is still operator data.
  app.get('/api/portal/chat-quality', routeRateLimitMiddleware, requirePortalAdminToken, (_req: Request, res: Response) => {
    try {
      const readiness = loadChatV2ReadinessReportFromFile();
      const dashboard = buildChatQualityDashboard(getDb(), {
        readinessReport: readiness.report,
        readinessUnavailableReason: readiness.reason ?? undefined,
      });
      res.json({ ok: true, dashboard });
    } catch (err) {
      sendPortalInternalError(res, err, 'Portal request failed', 'Portal: chat quality dashboard request failed');
    }
  });

  app.get('/chat-quality', (_req: Request, res: Response) => {
    res.type('html').send(CHAT_QUALITY_PAGE_HTML);
  });
}

const CHAT_QUALITY_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Chat Quality Dashboard</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; background: #0f1115; color: #e6e6e6; margin: 0; padding: 24px; }
  .card { max-width: 960px; margin: 0 auto 16px; background: #181b21; border: 1px solid #2a2f38; border-radius: 12px; padding: 20px; }
  h1 { font-size: 18px; margin: 0 0 12px; }
  h2 { font-size: 15px; margin: 0 0 8px; color: #c8d2de; }
  .meta { color: #9aa4b2; font-size: 13px; margin: 6px 0; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; margin: 8px 0; }
  th, td { border: 1px solid #2a2f38; padding: 5px 8px; text-align: left; }
  th { background: #10131a; color: #9aa4b2; font-weight: 600; }
  .pass { color: #6fc686; }
  .fail { color: #e07a7a; }
  button { background: #2a3442; color: #e6e6e6; border: 1px solid #3a4656; border-radius: 8px; padding: 8px 12px; margin: 4px 0; cursor: pointer; font-size: 14px; }
  button:hover { background: #35516d; }
  input { background: #10131a; color: #e6e6e6; border: 1px solid #2a2f38; border-radius: 8px; padding: 8px; width: 100%; box-sizing: border-box; }
</style>
</head>
<body>
<div class="card" id="auth">
  <h1>Chat Quality Dashboard</h1>
  <p class="meta">Portal admin token (stored locally, sent as Bearer):</p>
  <input id="token" type="password" placeholder="portal admin token">
  <button onclick="saveToken()">Load</button>
</div>
<div id="dashboard" style="display:none"></div>
<script>
function token() { return localStorage.getItem('chatQualityToken') || ''; }
function saveToken() {
  localStorage.setItem('chatQualityToken', document.getElementById('token').value.trim());
  load();
}
function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
  });
}
function num(value) { return value == null ? 'n/a' : (typeof value === 'number' ? Math.round(value * 10000) / 10000 : value); }
function table(headers, rows) {
  var head = '<tr>' + headers.map(function (header) { return '<th>' + esc(header) + '</th>'; }).join('') + '</tr>';
  var body = rows.map(function (row) {
    return '<tr>' + row.map(function (cell) { return '<td>' + cell + '</td>'; }).join('') + '</tr>';
  }).join('');
  return '<table>' + head + body + '</table>';
}
function card(title, inner) { return '<div class="card"><h2>' + esc(title) + '</h2>' + inner + '</div>'; }
function passCell(passed) { return passed ? '<span class="pass">pass</span>' : '<span class="fail">FAIL</span>'; }
async function load() {
  var response = await fetch('/api/portal/chat-quality', { headers: { 'Authorization': 'Bearer ' + token() } });
  if (!response.ok) { alert('HTTP ' + response.status); return; }
  var data = await response.json();
  var d = data.dashboard;
  document.getElementById('auth').style.display = 'none';
  var root = document.getElementById('dashboard');
  root.style.display = 'block';
  var html = '';

  html += card('Eval score trend', table(
    ['Run', 'Mode', 'Generated', 'Avg score', 'Result', 'P/Pa/F/B', 'Estimated actual spend (USD)', 'Budget ceiling (USD)', 'Judge calls'],
    d.evalTrend.map(function (run) {
      return [esc(run.runId), esc(run.mode), esc(run.generatedAt), num(run.averageScore), passCell(run.passed),
        run.passCount + '/' + run.partialCount + '/' + run.failCount + '/' + run.blockedCount,
        num(run.estimatedActualSpendUsd), num(run.budgetCeilingUsd), run.realProviderCalls];
    })
  ) + '<p class="meta">Monthly eval cost evidence: ' + table(
    ['Month', 'Estimated actual USD', 'Budget ceiling USD', 'Actual evidence', 'Runs'],
    d.monthlyEvalSpend.months.map(function (m) {
      return [esc(m.month), num(m.totalEstimatedActualSpendUsd), num(m.totalBudgetCeilingUsd),
        m.actualSpendEvidenceRunCount + '/' + m.runCount, m.runCount];
    })
  ) + 'Current month estimated actual: $' + num(d.monthlyEvalSpend.currentMonthEstimatedActualSpendUsd)
    + '; budget ceiling: $' + num(d.monthlyEvalSpend.currentMonthBudgetCeilingUsd) + '</p>');

  var frozen = d.frozenLiveBaseline;
  if (!frozen || frozen.status === 'not_recorded') {
    html += card('Frozen live baseline',
      '<p class="meta">Not recorded — quality deltas unavailable. Run and explicitly accept the first dedicated-tenant staging real_provider baseline.</p>');
  } else {
    var baseline = frozen.baseline;
    var baselineInner = table(
      ['Identity', 'Accepted', 'Git SHA', 'Avg score', 'Scenario pass rate', 'Estimated actual spend', 'Budget ceiling'],
      [[esc(baseline.runId), esc(baseline.acceptedAt), esc(baseline.gitCommit), num(baseline.averageScore),
        num(baseline.scenarioPassRate), num(baseline.totalEstimatedActualSpendUsd), num(baseline.totalBudgetCeilingUsd)]]
    );
    if (frozen.status === 'baseline_only') {
      baselineInner += '<p class="meta">Baseline frozen; no later real_provider run exists, so quality deltas unavailable.</p>';
    } else if (frozen.status === 'incompatible') {
      baselineInner += '<p class="fail">Latest run ' + esc(frozen.latestFollowup.runId)
        + ' is not comparable (' + esc(frozen.comparison.reason) + '); quality deltas unavailable.</p>';
    } else {
      baselineInner += table(
        ['Latest run', 'Avg score delta', 'Scenario pass-rate delta', 'Fail-count delta', 'Blocked-count delta', 'Estimated actual-spend delta'],
        [[esc(frozen.latestFollowup.runId), num(frozen.comparison.averageScoreDelta),
          num(frozen.comparison.scenarioPassRateDelta), num(frozen.comparison.failCountDelta),
          num(frozen.comparison.blockedCountDelta), num(frozen.comparison.estimatedActualSpendUsdDelta)]]
      );
    }
    html += card('Frozen live baseline', baselineInner);
  }

  html += card('Day-to-day failure types (last ' + d.failureTypeBreakdown.runsConsidered + ' run(s))', table(
    ['Failure type', 'Count'],
    Object.entries(d.failureTypeBreakdown.counts).sort(function (a, b) { return b[1] - a[1]; })
      .map(function (entry) { return [esc(entry[0]), entry[1]]; })
  ));

  html += card('Locale leakage (real_provider run preferred; mode labeled)',
    '<p class="meta">Run: ' + esc(d.localeLeakage.runId || 'none')
    + ' — mode ' + esc(d.localeLeakage.mode || 'n/a')
    + ' — leaked ' + d.localeLeakage.leakedCount
    + ' / ' + d.localeLeakage.scenarioCount + ' (rate ' + num(d.localeLeakage.rate) + ')</p>');

  html += card('Quality-gate outcomes (process-local since boot)', table(
    ['Outcome', 'Count'],
    Object.entries(d.qualityGateOutcomes).map(function (entry) { return [esc(entry[0]), entry[1]]; })
  ));

  var clarify = d.routingClarifyBudget;
  var clarifyStatus = clarify.withinBudget == null
    ? '<span class="meta">no evidence</span>'
    : passCell(clarify.withinBudget);
  html += card('Routing clarify budget', table(
    ['Window', 'Clarified', 'Evaluated', 'Rate', 'Limit', 'Status'],
    [[clarify.windowDays + ' days', clarify.clarifiedTurns, clarify.evaluatedTurns,
      num(clarify.rate), num(clarify.budgetLimit), clarifyStatus]]
  ));

  var routing = d.routingAccuracy;
  var routingInner = '<p class="meta">Accepted snapshot: ' + esc(routing.snapshotGeneratedAt || 'none') + '</p>';
  if (routing.surfaces) {
    routing.surfaces.forEach(function (surface) {
      routingInner += '<p class="meta">' + esc(surface.surface) + ' — covered ' + surface.covered
        + ', accuracy ' + num(surface.accuracy) + '</p>';
      routingInner += table(['Domain', 'Support', 'Precision', 'Recall'],
        surface.perDomain.map(function (row) {
          return [esc(row.domain), row.support, num(row.precision), num(row.recall)];
        }));
    });
  }
  var progress = routing.corpusProgress;
  routingInner += '<p class="meta">Corpus labeling: ' + progress.labeled + ' labeled / ' + progress.pending
    + ' pending / ' + progress.skipped + ' skipped (total ' + progress.total
    + ') — label at <a href="/routing-corpus" style="color:#7fb3e0">/routing-corpus</a></p>';
  html += card('Routing accuracy (latest ACCEPTED snapshot)', routingInner);

  var readiness = d.readiness;
  if (!readiness.available) {
    html += card('ChatV2 readiness / retirement', '<p class="meta">Unavailable: ' + esc(readiness.reason) + '</p>');
  } else {
    html += card('ChatV2 readiness / retirement (report ' + esc(readiness.generatedAt || '') + ')', table(
      ['Phase', 'Result', 'Gates', 'Blocked'],
      readiness.rows.map(function (row) {
        return [esc(row.phase), passCell(row.passed), row.gateCount, row.blockedGateCount];
      })
    ));
  }

  var campaign = d.retirementCampaign;
  html += card('ChatV2 per-route retirement campaign (paired behavior + 24h fallback)',
    '<p class="meta">PASS candidates: ' + campaign.candidateRouteCount
      + ' — fallback alerts: ' + campaign.alertRouteCount
      + ' — ceiling: ' + num(campaign.fallbackThreshold * 100) + '%</p>'
    + table(
      ['Route', 'Disable stage', 'Behavior', 'Parity', 'Routing diag', 'Fallback 24h', 'Verdict'],
      campaign.rows.map(function (row) {
        var behavior = row.behaviorMatchingCount + '/' + row.behaviorParitySamples;
        var routing = row.routingAgreementSamples > 0
          ? row.routingAgreementCount + '/' + row.routingAgreementSamples
          : 'diagnostic n/a';
        var fallback = row.fallback24h.rate == null
          ? 'no evidence'
          : row.fallback24h.fallbackCount + '/' + row.fallback24h.totalCount
            + ' (' + num(row.fallback24h.rate * 100) + '%)';
        var verdict = row.verdict === 'pass'
          ? '<span class="pass">PASS</span>'
          : '<span class="fail">' + esc(row.verdict.toUpperCase()) + '</span>';
        return [esc(row.routeId), esc(row.disableStages.join(',') || 'blocked:' + row.mappingStatus),
          behavior, num(row.behaviorParityRate), routing, fallback, verdict];
      })
    )
    + '<p class="meta">Routing agreement and online-eval health are diagnostic only; they never produce PASS.</p>');

  html += card('Online-eval sampler captures (last ' + d.samplerCaptures.windowDays + ' days, counts only)', table(
    ['Status', 'Reason', 'Count'],
    d.samplerCaptures.byReason.map(function (row) { return [esc(row.status), esc(row.reason), row.count]; })
  ) + '<p class="meta">Total: ' + d.samplerCaptures.total + '</p>');

  root.innerHTML = html;
}
if (token()) load();
</script>
</body>
</html>
`;
