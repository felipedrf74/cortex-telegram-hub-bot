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
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { extractClientIp } from '../api/rate-limiter';
import { getPortalAuthContext, requirePortalAdminToken } from '../api/secret-guards';
import { config } from '../config';
import { getDb } from '../services/database';
import {
  getNextPendingRoutingCorpusItem,
  getRoutingCorpusItemById,
  getRoutingCorpusProgress,
  getRoutingLabelCandidates,
  isCheckedInSyntheticRoutingCorpusItem,
  isValidRoutingLabelDomain,
  isValidRoutingLabelSelection,
  labelRoutingCorpusItem,
  RoutingCorpusLabelConflictError,
} from '../services/routing-corpus';
import { getOwnerBootstrapTarget } from '../services/user-service';
import { isOperatorScopedToUser } from './admin-target-user';
import { insertPortalAdminMutationAuditStrict } from './admin-audit';
import { sendPortalInternalError } from './http';

export function registerPortalRoutingCorpusRoutes(app: Express): void {
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
        error: { code: 'RATE_LIMITED', message: 'Too many routing-corpus requests. Slow down.', retryAfter },
      });
    },
  });

  // PRIVACY NOTE: this endpoint can return raw user utterance text. It
  // defaults to tenant 0 checked-in synthetic controls. Nonzero access is
  // fail-closed to the owner bootstrap tenant plus a signed-session or
  // signature-verified actor in the configured operator scope. All page and
  // JSON responses are no-store.
  // PORTAL_ALLOW_LOCAL_BYPASS must never be enabled where the portal is
  // reachable by anyone but the owner.
  app.get('/api/portal/routing-corpus/next', routeRateLimitMiddleware, requirePortalAdminToken, (req: Request, res: Response) => {
    try {
      setRoutingCorpusNoStore(res);
      const tenantId = resolveRoutingCorpusTenant(req, res);
      if (tenantId === null) return;
      const db = getDb();
      const queryScope = { tenantId, syntheticOnly: tenantId === 0 };
      const item = getNextPendingRoutingCorpusItem(db, queryScope);
      res.json({
        ok: true,
        item,
        candidates: getRoutingLabelCandidates(),
        progress: getRoutingCorpusProgress(db, queryScope),
      });
    } catch (err) {
      sendPortalInternalError(res, err, 'Portal request failed', 'Portal: routing corpus next request failed');
    }
  });

  app.post('/api/portal/routing-corpus/label', routeRateLimitMiddleware, requirePortalAdminToken, express.json({ limit: '64kb' }), (req: Request, res: Response) => {
    try {
      setRoutingCorpusNoStore(res);
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
        if (
          body.labelSkill !== undefined
          && body.labelSkill !== null
          && (typeof body.labelSkill !== 'string' || body.labelSkill.length === 0)
        ) {
          res.status(400).json({
            ok: false,
            error: {
              code: 'INVALID_LABEL_SKILL',
              message: 'labelSkill must be a non-empty string when provided',
            },
          });
          return;
        }
        if (!isValidRoutingLabelSelection(labelDomain, labelSkill, candidates)) {
          const expected = candidates.specialLabels.includes(labelDomain)
            ? 'no skill'
            : `one of: ${(candidates.skillsByDomain[labelDomain] ?? []).join(', ')}, or domain-only`;
          res.status(400).json({
            ok: false,
            error: {
              code: 'INVALID_LABEL_SKILL',
              message: `labelSkill for ${labelDomain} must be ${expected}`,
            },
          });
          return;
        }
      }

      const db = getDb();
      const mutateAndAudit = db.transaction(() => {
        const pendingItem = getRoutingCorpusItemById(id, db);
        if (!pendingItem) return null;
        if (!canAccessRoutingCorpusItem(req, pendingItem)) {
          throw new RoutingCorpusScopeError(pendingItem.tenantId);
        }
        const mutatedItem = labelRoutingCorpusItem({ id, action, labelDomain, labelSkill }, db);
        if (!mutatedItem) return null;
        insertPortalAdminMutationAuditStrict(
          db,
          req,
          {
            userId: mutatedItem.userId ?? 0,
            tenantId: mutatedItem.tenantId,
            resource: `portal.routing_corpus.${action}`,
            details: {
              itemId: mutatedItem.id,
              tenantId: mutatedItem.tenantId,
              source: mutatedItem.source,
              action,
              labelDomain: mutatedItem.labelDomain,
              labelSkill: mutatedItem.labelSkill,
            },
          },
        );
        return mutatedItem;
      });
      const item = mutateAndAudit.immediate();
      if (!item) {
        res.status(404).json({
          ok: false,
          error: { code: 'ITEM_NOT_FOUND', message: `routing corpus item ${id} not found` },
        });
        return;
      }
      res.json({ ok: true, item });
    } catch (err) {
      if (err instanceof RoutingCorpusScopeError) {
        res.status(403).json({
          ok: false,
          error: {
            code: 'FORBIDDEN',
            message: 'routing corpus access is restricted to synthetic controls or the owner tenant',
          },
        });
        return;
      }
      if (err instanceof RoutingCorpusLabelConflictError) {
        res.status(409).json({
          ok: false,
          error: {
            code: 'ITEM_NOT_PENDING',
            message: `routing corpus item ${err.itemId} is no longer pending`,
          },
        });
        return;
      }
      sendPortalInternalError(res, err, 'Portal request failed', 'Portal: routing corpus label request failed');
    }
  });

  app.get('/api/portal/routing-corpus/progress', routeRateLimitMiddleware, requirePortalAdminToken, (req: Request, res: Response) => {
    try {
      setRoutingCorpusNoStore(res);
      const tenantId = resolveRoutingCorpusTenant(req, res);
      if (tenantId === null) return;
      res.json({
        ok: true,
        progress: getRoutingCorpusProgress(getDb(), {
          tenantId,
          syntheticOnly: tenantId === 0,
        }),
      });
    } catch (err) {
      sendPortalInternalError(res, err, 'Portal request failed', 'Portal: routing corpus progress request failed');
    }
  });

  app.get('/routing-corpus', (_req: Request, res: Response) => {
    setRoutingCorpusNoStore(res);
    res.type('html').send(ROUTING_CORPUS_PAGE_HTML);
  });
}

class RoutingCorpusScopeError extends Error {
  constructor(readonly tenantId: number) {
    super(`Routing corpus tenant ${tenantId} is outside the owner scope`);
    this.name = 'RoutingCorpusScopeError';
  }
}

function setRoutingCorpusNoStore(res: Response): void {
  res.setHeader('Cache-Control', 'no-store, max-age=0, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
}

function hasVerifiedPortalActor(req: Request): boolean {
  const auth = getPortalAuthContext(req);
  return Boolean(
    auth?.actorHint
    && (auth.actorSignatureVerified === true || auth.sessionSignatureVerified === true),
  );
}

function canAccessPrivateRoutingCorpusTenant(req: Request, tenantId: number): boolean {
  const ownerTarget = getOwnerBootstrapTarget();
  if (!ownerTarget || ownerTarget.tenantId !== tenantId) return false;
  const auth = getPortalAuthContext(req);
  if (!hasVerifiedPortalActor(req) || !auth?.actorHint) return false;
  return isOperatorScopedToUser(
    auth.actorHint,
    tenantId,
    config.portal.operatorUserScopes ?? {},
  );
}

function canAccessRoutingCorpusItem(
  req: Request,
  item: Parameters<typeof isCheckedInSyntheticRoutingCorpusItem>[0],
): boolean {
  if (isCheckedInSyntheticRoutingCorpusItem(item)) return true;
  return canAccessPrivateRoutingCorpusTenant(req, item.tenantId);
}

function resolveRoutingCorpusTenant(req: Request, res: Response): number | null {
  const raw = req.query.tenantId;
  if (raw === undefined || raw === null || raw === '') return 0;
  const text = String(raw);
  if (!/^\d+$/.test(text)) {
    res.status(400).json({
      ok: false,
      error: { code: 'INVALID_TENANT_ID', message: 'tenantId must be a non-negative integer' },
    });
    return null;
  }
  const tenantId = Number(text);
  if (!Number.isSafeInteger(tenantId) || tenantId < 0) {
    res.status(400).json({
      ok: false,
      error: { code: 'INVALID_TENANT_ID', message: 'tenantId must be a non-negative integer' },
    });
    return null;
  }
  if (tenantId !== 0 && !canAccessPrivateRoutingCorpusTenant(req, tenantId)) {
    res.status(403).json({
      ok: false,
      error: {
        code: 'FORBIDDEN',
        message: 'routing corpus access is restricted to synthetic controls or the owner tenant',
      },
    });
    return null;
  }
  return tenantId;
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
    <div id="skills"></div>
    <button class="skip" onclick="submitLabel('skip')">Skip</button>
  </div>
</div>
<script>
let current = null;
let currentCandidates = null;
function token() { return localStorage.getItem('routingCorpusToken') || ''; }
function corpusScopeQuery() {
  const tenantId = new URLSearchParams(window.location.search).get('tenantId');
  return tenantId === null ? '' : '?tenantId=' + encodeURIComponent(tenantId);
}
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
  const data = await api('/api/portal/routing-corpus/next' + corpusScopeQuery());
  current = data.item;
  currentCandidates = data.candidates;
  document.getElementById('skills').innerHTML = '';
  const progress = data.progress;
  document.getElementById('progress').textContent =
    'Labeled ' + progress.labeled + ' / ' + progress.total + ' (pending ' + progress.pending + ', skipped ' + progress.skipped + ')';
  if (!current) {
    document.getElementById('utterance').textContent = 'No pending items. All done.';
    document.getElementById('itemMeta').textContent = '';
    document.getElementById('domains').innerHTML = '';
    document.getElementById('skills').innerHTML = '';
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
    btn.onclick = () => {
      if (data.candidates.specialLabels.includes(domain)) {
        submitLabel('label', domain);
        return;
      }
      selectDomain(domain);
    };
    container.appendChild(btn);
  }
}
function selectDomain(domain) {
  const container = document.getElementById('skills');
  container.innerHTML = '';
  const hint = document.createElement('div');
  hint.className = 'meta';
  hint.textContent = 'Select the executable skill, or explicitly choose domain-only:';
  container.appendChild(hint);

  const domainOnly = document.createElement('button');
  domainOnly.textContent = 'Domain only / skill unsure';
  domainOnly.onclick = () => submitLabel('label', domain, null);
  container.appendChild(domainOnly);

  for (const skill of currentCandidates.skillsByDomain[domain] || []) {
    const btn = document.createElement('button');
    btn.textContent = skill;
    if (skill === current.suggestedSkill) btn.className = 'suggested';
    btn.onclick = () => submitLabel('label', domain, skill);
    container.appendChild(btn);
  }
}
async function submitLabel(action, labelDomain, labelSkill) {
  if (!current) return;
  if (
    action === 'label'
    && !currentCandidates.specialLabels.includes(labelDomain)
    && labelSkill === undefined
  ) return;
  await api('/api/portal/routing-corpus/label', {
    method: 'POST',
    body: JSON.stringify({
      id: current.id,
      action: action,
      labelDomain: labelDomain,
      labelSkill: labelSkill,
    }),
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
