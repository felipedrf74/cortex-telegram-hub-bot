// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Milestone 7 — portal labeling page for the golden routing corpus.
 *
 * JSON endpoints (admin token, same conventions as eval-history-routes):
 *   GET  /api/portal/routing-corpus/next      next pending item + candidates
 *   POST /api/portal/routing-corpus/label     label or skip one item
 *   GET  /api/portal/routing-corpus/progress  labeling progress counts
 *
 * Plus a minimal HTML page at /routing-corpus. The page itself carries no
 * data; it asks for the portal admin token and calls the JSON endpoints
 * with a Bearer header (portal.html pattern).
 */

import express, { type Express, type Request, type Response } from 'express';
import { requirePortalAdminToken } from '../api/secret-guards';
import { getDb } from '../services/database';
import {
  getNextPendingRoutingCorpusItem,
  getRoutingCorpusProgress,
  getRoutingLabelCandidates,
  isValidRoutingLabelDomain,
  labelRoutingCorpusItem,
} from '../services/routing-corpus';
import { sendPortalInternalError } from './http';

export function registerPortalRoutingCorpusRoutes(app: Express): void {
  // PRIVACY NOTE: this endpoint returns RAW user utterance text
  // (item.utteranceText) for labeling. Its only access control is
  // requirePortalAdminToken (src/api/secret-guards enforcePortalToken,
  // admin scope) — with the documented secret-guards caveat that
  // PORTAL_ALLOW_LOCAL_BYPASS=true waives the token for loopback requests
  // (allowLocalPortalBypass), so that bypass must never be enabled where
  // this portal is reachable by anyone but the owner.
  app.get('/api/portal/routing-corpus/next', requirePortalAdminToken, (req: Request, res: Response) => {
    try {
      const tenantId = parseTenantId(req.query.tenantId);
      const db = getDb();
      const item = getNextPendingRoutingCorpusItem(db, tenantId !== undefined ? { tenantId } : {});
      res.json({
        ok: true,
        item,
        candidates: getRoutingLabelCandidates(),
        progress: getRoutingCorpusProgress(db, tenantId !== undefined ? { tenantId } : {}),
      });
    } catch (err) {
      sendPortalInternalError(res, err, 'Portal request failed', 'Portal: routing corpus next request failed');
    }
  });

  app.post('/api/portal/routing-corpus/label', requirePortalAdminToken, express.json({ limit: '64kb' }), (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const id = typeof body.id === 'number' && Number.isInteger(body.id) && body.id > 0 ? body.id : null;
      const action = body.action === 'label' || body.action === 'skip' ? body.action : null;
      if (!id || !action) {
        res.status(400).json({
          ok: false,
          error: { code: 'INVALID_LABEL_REQUEST', message: 'id (positive integer) and action (label|skip) are required' },
        });
        return;
      }

      let labelDomain: string | undefined;
      let labelSkill: string | undefined;
      if (action === 'label') {
        const candidates = getRoutingLabelCandidates();
        labelDomain = typeof body.labelDomain === 'string' ? body.labelDomain : undefined;
        labelSkill = typeof body.labelSkill === 'string' && body.labelSkill.length > 0 ? body.labelSkill : undefined;
        if (!labelDomain || !isValidRoutingLabelDomain(labelDomain, candidates)) {
          res.status(400).json({
            ok: false,
            error: {
              code: 'INVALID_LABEL_DOMAIN',
              message: `labelDomain must be one of: ${[...candidates.domains, ...candidates.specialLabels].join(', ')}`,
            },
          });
          return;
        }
      }

      const item = labelRoutingCorpusItem({ id, action, labelDomain, labelSkill }, getDb());
      if (!item) {
        res.status(404).json({
          ok: false,
          error: { code: 'ITEM_NOT_FOUND', message: `routing corpus item ${id} not found` },
        });
        return;
      }
      res.json({ ok: true, item });
    } catch (err) {
      sendPortalInternalError(res, err, 'Portal request failed', 'Portal: routing corpus label request failed');
    }
  });

  app.get('/api/portal/routing-corpus/progress', requirePortalAdminToken, (req: Request, res: Response) => {
    try {
      const tenantId = parseTenantId(req.query.tenantId);
      res.json({
        ok: true,
        progress: getRoutingCorpusProgress(getDb(), tenantId !== undefined ? { tenantId } : {}),
      });
    } catch (err) {
      sendPortalInternalError(res, err, 'Portal request failed', 'Portal: routing corpus progress request failed');
    }
  });

  app.get('/routing-corpus', (_req: Request, res: Response) => {
    res.type('html').send(ROUTING_CORPUS_PAGE_HTML);
  });
}

function parseTenantId(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const parsed = Number.parseInt(String(raw), 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

const ROUTING_CORPUS_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Routing Corpus Labeling</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; background: #0f1115; color: #e6e6e6; margin: 0; padding: 24px; }
  .card { max-width: 720px; margin: 0 auto; background: #181b21; border: 1px solid #2a2f38; border-radius: 12px; padding: 20px; }
  h1 { font-size: 18px; margin: 0 0 12px; }
  .meta, #progress { color: #9aa4b2; font-size: 13px; margin: 8px 0; }
  #utterance { font-size: 17px; background: #10131a; border: 1px solid #2a2f38; border-radius: 8px; padding: 14px; margin: 12px 0; white-space: pre-wrap; }
  button { background: #2a3442; color: #e6e6e6; border: 1px solid #3a4656; border-radius: 8px; padding: 8px 12px; margin: 4px; cursor: pointer; font-size: 14px; }
  button:hover { background: #35516d; }
  button.skip { background: #3a2a2a; }
  input { background: #10131a; color: #e6e6e6; border: 1px solid #2a2f38; border-radius: 8px; padding: 8px; width: 100%; box-sizing: border-box; }
  .suggested { outline: 2px solid #4f8cc9; }
</style>
</head>
<body>
<div class="card">
  <h1>Routing Corpus Labeling</h1>
  <div id="auth">
    <p class="meta">Portal admin token (stored locally, sent as Bearer):</p>
    <input id="token" type="password" placeholder="portal admin token">
    <button onclick="saveToken()">Start</button>
  </div>
  <div id="labeler" style="display:none">
    <div id="progress"></div>
    <div id="utterance"></div>
    <div class="meta" id="itemMeta"></div>
    <div id="domains"></div>
    <button class="skip" onclick="submitLabel('skip')">Skip</button>
  </div>
</div>
<script>
let current = null;
function token() { return localStorage.getItem('routingCorpusToken') || ''; }
function saveToken() {
  localStorage.setItem('routingCorpusToken', document.getElementById('token').value.trim());
  document.getElementById('auth').style.display = 'none';
  document.getElementById('labeler').style.display = 'block';
  loadNext();
}
async function api(path, options) {
  const response = await fetch(path, Object.assign({
    headers: { 'Authorization': 'Bearer ' + token(), 'Content-Type': 'application/json' },
  }, options));
  if (!response.ok) throw new Error('HTTP ' + response.status);
  return response.json();
}
async function loadNext() {
  const data = await api('/api/portal/routing-corpus/next');
  current = data.item;
  const progress = data.progress;
  document.getElementById('progress').textContent =
    'Labeled ' + progress.labeled + ' / ' + progress.total + ' (pending ' + progress.pending + ', skipped ' + progress.skipped + ')';
  if (!current) {
    document.getElementById('utterance').textContent = 'No pending items. All done.';
    document.getElementById('itemMeta').textContent = '';
    document.getElementById('domains').innerHTML = '';
    return;
  }
  document.getElementById('utterance').textContent = current.utteranceText;
  document.getElementById('itemMeta').textContent =
    'source: ' + current.source + (current.suggestedDomain ? ' · suggested: ' + current.suggestedDomain : '');
  const container = document.getElementById('domains');
  container.innerHTML = '';
  const labels = data.candidates.domains.concat(data.candidates.specialLabels);
  for (const domain of labels) {
    const btn = document.createElement('button');
    btn.textContent = domain;
    if (domain === current.suggestedDomain) btn.className = 'suggested';
    btn.onclick = () => submitLabel('label', domain);
    container.appendChild(btn);
  }
}
async function submitLabel(action, labelDomain) {
  if (!current) return;
  await api('/api/portal/routing-corpus/label', {
    method: 'POST',
    body: JSON.stringify({ id: current.id, action: action, labelDomain: labelDomain }),
  });
  await loadNext();
}
if (token()) {
  document.getElementById('auth').style.display = 'none';
  document.getElementById('labeler').style.display = 'block';
  loadNext();
}
</script>
</body>
</html>
`;
