// Founders tab — emails with permanent Pro or Max access.
const P = window.NexusPortal;

let root = null;

function el(id) { return root.querySelector('#' + id); }

function updateBadge(count) {
  const badge = document.getElementById('nav-founders-count');
  if (!badge) return;
  badge.textContent = String(count);
  badge.hidden = !(count > 0);
}

async function load() {
  try {
    const d = await P.apiJson('/api/founders');
    const founders = d.founders || [];
    updateBadge(founders.length);
    const tbody = el('founders-tbody');
    if (founders.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5"><div class="empty">No founders yet. Add an email above to grant permanent access.</div></td></tr>';
      return;
    }
    tbody.innerHTML = founders.map((f) => {
      const planBadge = f.plan === 'max'
        ? '<span class="badge badge-accent">MAX</span>'
        : '<span class="badge badge-success">PRO</span>';
      return '<tr>' +
        '<td><code class="u-fs-13 mono">' + P.esc(f.email) + '</code></td>' +
        '<td>' + planBadge + '</td>' +
        '<td class="text-muted">' + P.esc(f.note || '—') + '</td>' +
        '<td class="text-muted">' + (f.created_at ? P.shortDateTime(f.created_at) : '—') + '</td>' +
        '<td class="text-right"><button class="btn btn-xs btn-danger" data-op="remove" data-email="' + P.esc(f.email) + '">Remove</button></td>' +
      '</tr>';
    }).join('');
  } catch (err) {
    P.setTableError('founders-tbody', 5, 'Could not load founders', err);
  }
}

async function remove(email) {
  if (!window.confirm('Remove founder access for ' + email + '?')) return;
  await P.apiFetch('/api/founders/' + encodeURIComponent(email), { method: 'DELETE' });
  P.showToast('Founder removed');
  load();
}

async function add() {
  const email = el('founder-email-input').value.trim();
  const plan = el('founder-plan-select').value;
  const note = el('founder-note-input').value.trim();
  if (!email) { P.showToast('Email is required', false); return; }
  try {
    const r = await P.apiFetch('/api/founders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, plan, note: note || undefined }),
    });
    if (!r.ok) { P.showToast('Failed to add founder', false); return; }
    P.showToast('Founder added: ' + email);
    el('founder-email-input').value = '';
    el('founder-note-input').value = '';
    load();
  } catch (_) {
    P.showToast('Error adding founder', false);
  }
}

// Badge count without opening the tab (called from app start).
async function refreshBadge() {
  try {
    const d = await P.apiJson('/api/founders');
    updateBadge((d.founders || []).length);
  } catch (_) {
    // badge is best-effort
  }
}

function mount(container) {
  root = container;
  const label = (text) => '<label class="u-fs-11 u-fw-600 u-c-text-secondary u-tt-uppercase u-ls-0-5 u-mb-4 u-d-block">' + text + '</label>';
  root.innerHTML =
    '<div class="section-header"><div><h1 class="section-title">Founders</h1>' +
    '<div class="section-subtitle">Emails with permanent Pro or Max access — no paywall, no expiry</div></div></div>' +
    '<div class="u-mb-space-4 card"><div class="u-d-flex u-gap-space-3 u-ai-end u-flexwrap-wrap">' +
    '<div class="u-flex-1 u-minw-200">' + label('Email') + '<input class="u-w-100p input" type="email" placeholder="user@example.com" id="founder-email-input"></div>' +
    '<div class="u-minw-100">' + label('Plan') + '<select class="u-w-100p input" id="founder-plan-select"><option value="pro">Pro</option><option value="max">Max</option></select></div>' +
    '<div class="u-flex-0-6 u-minw-140">' + label('Note (optional)') + '<input class="u-w-100p input" type="text" placeholder="Beta tester, Investor…" id="founder-note-input"></div>' +
    '<button class="u-h-36 btn btn-primary btn-sm" id="founder-add-btn">+ Add Founder</button></div></div>' +
    '<div class="card"><div class="u-ovx-auto"><table class="data-table" id="founders-table"><thead><tr>' +
    '<th>Email</th><th>Plan</th><th>Note</th><th>Added</th><th class="u-w-60"></th></tr></thead>' +
    '<tbody id="founders-tbody"><tr><td colspan="5"><div class="empty">Loading founders…</div></td></tr></tbody></table></div></div>';
  el('founder-add-btn').addEventListener('click', add);
  root.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-op="remove"]');
    if (btn) remove(btn.dataset.email);
  });
}

P.registerSection('founders', {
  mount,
  onShow() { load(); },
  refreshBadge,
});
