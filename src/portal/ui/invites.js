// Invite codes tab — create, list, copy and revoke closed-beta invite codes.
const P = window.NexusPortal;

let root = null;

function el(id) { return root.querySelector('#' + id); }

async function load() {
  try {
    const d = await P.apiJson('/api/invite-codes');
    const box = el('invite-codes-content');
    const codes = d.codes || [];
    if (codes.length === 0) {
      box.innerHTML = '<div class="empty">No invite codes yet. Click <b>+ New Code</b> to create one.</div>';
      return;
    }
    box.innerHTML = '<table class="data-table"><thead><tr>' +
      '<th>Code</th><th>Uses</th><th>Status</th><th>Created</th><th></th>' +
      '</tr></thead><tbody>' +
      codes.map((c) => {
        const expired = c.expires_at && new Date(c.expires_at) < new Date();
        const exhausted = c.used_count >= c.max_uses;
        const status = expired
          ? '<span class="badge badge-error">⏰ Expired</span>'
          : exhausted
            ? '<span class="badge badge-neutral">✅ Used</span>'
            : '<span class="badge badge-success">🟢 Active</span>';
        return '<tr>' +
          '<td><code class="u-fs-13 u-fw-600 u-ls-1 mono">' + P.esc(c.code) + '</code></td>' +
          '<td class="mono">' + c.used_count + ' / ' + c.max_uses + '</td>' +
          '<td>' + status + '</td>' +
          '<td class="text-muted">' + (c.created_at ? P.shortDateTime(c.created_at) : '—') + '</td>' +
          '<td class="text-right">' +
            '<button class="btn btn-xs" data-op="copy" data-code="' + P.esc(c.code) + '">Copy</button> ' +
            '<button class="btn btn-xs btn-danger" data-op="revoke" data-code="' + P.esc(c.code) + '">Revoke</button>' +
          '</td>' +
        '</tr>';
      }).join('') + '</tbody></table>';
  } catch (err) {
    P.setCardError('invite-codes-content', 'Could not load invite codes', err);
  }
}

function copy(code) {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(code).then(() => P.showToast('Copied to clipboard'));
  }
}

async function revoke(code) {
  if (!window.confirm('Revoke code ' + code + '?')) return;
  await P.apiFetch('/api/invite-codes/' + encodeURIComponent(code), { method: 'DELETE' });
  P.showToast('Code revoked');
  load();
}

async function create() {
  try {
    const r = await P.apiFetch('/api/invite-codes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxUses: 1 }),
    });
    if (!r.ok) { P.showToast('Failed', false); return; }
    const d = await r.json();
    if (d.ok) P.showToast('Created: ' + d.code);
    load();
  } catch (_) {
    P.showToast('Error', false);
  }
}

function mount(container) {
  root = container;
  root.innerHTML =
    '<div class="section-header"><div><h1 class="section-title">Invite Codes</h1>' +
    '<div class="section-subtitle">Create, list, and revoke codes</div></div>' +
    '<div class="section-actions"><button class="btn btn-primary btn-sm" id="create-invite-btn">+ New Code</button></div></div>' +
    '<div class="card"><div id="invite-codes-content"><div class="empty">Loading codes…</div></div></div>';
  el('create-invite-btn').addEventListener('click', create);
  root.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-op]');
    if (!btn) return;
    if (btn.dataset.op === 'copy') copy(btn.dataset.code);
    else if (btn.dataset.op === 'revoke') revoke(btn.dataset.code);
  });
}

P.registerSection('invites', {
  mount,
  onShow() { load(); },
});
