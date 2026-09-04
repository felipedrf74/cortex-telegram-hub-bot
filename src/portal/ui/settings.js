// Settings tab — runtime configuration from DatabaseConfigProvider, grouped
// by category; env-locked keys are read-only, DB overrides can be reset.
const P = window.NexusPortal;

let root = null;

const CATEGORY_ICONS = { general: '⚙️', notifications: '🔔', skills: '🧩', ai: '🤖', limits: '🚦' };

function inputFor(s) {
  const id = P.esc(String(s.id));
  if (s.locked) return '<input type="text" value="' + P.esc(String(s.value)) + '" disabled style="opacity:0.6">';
  if (s.options) {
    const opts = s.options.map((o) => '<option value="' + P.esc(o) + '"' + (o === String(s.value) ? ' selected' : '') + '>' + P.esc(o) + '</option>').join('');
    return '<select data-op="update" data-kind="text" data-id="' + id + '">' + opts + '</select>';
  }
  if (s.type === 'boolean') {
    return '<select data-op="update" data-kind="bool" data-id="' + id + '">' +
      '<option value="true"' + (s.value ? ' selected' : '') + '>Enabled</option>' +
      '<option value="false"' + (!s.value ? ' selected' : '') + '>Disabled</option>' +
    '</select>';
  }
  if (s.type === 'number') return '<input type="number" value="' + P.esc(String(s.value)) + '" style="max-width:120px" data-op="update" data-kind="number" data-id="' + id + '">';
  return '<input type="text" value="' + P.esc(String(s.value)) + '" data-op="update" data-kind="text" data-id="' + id + '">';
}

async function load() {
  try {
    const d = await P.apiJson('/api/settings');
    const box = root.querySelector('#settings-content');
    const settings = d.settings || [];
    if (settings.length === 0) {
      box.innerHTML = '<div class="empty">No settings available (DatabaseConfigProvider not active)</div>';
      return;
    }
    const cats = {};
    settings.forEach((s) => { const c = s.category || 'general'; (cats[c] = cats[c] || []).push(s); });
    box.innerHTML = Object.entries(cats).map(([cat, items]) => {
      const icon = CATEGORY_ICONS[cat] || '📋';
      const rows = items.map((s) => {
        const srcBadge = s.locked
          ? '<span class="badge badge-neutral">🔒 ENV</span>'
          : s.source === 'database'
            ? '<span class="badge badge-success">💾 DB</span>'
            : '<span class="badge badge-neutral">⚙️ Default</span>';
        const resetBtn = (!s.locked && s.source === 'database')
          ? '<button class="btn btn-xs" data-op="reset" data-id="' + P.esc(String(s.id)) + '">Reset</button>'
          : '';
        return '<div class="flex gap-3" style="align-items:center;margin-bottom:10px">' +
          '<div style="min-width:200px"><div style="font-weight:500;font-size:12px">' + P.esc(s.label || s.id) + '</div>' +
          (s.description ? '<div class="text-tertiary" style="font-size:10px">' + P.esc(s.description) + '</div>' : '') + '</div>' +
          '<div style="flex:1;max-width:280px">' + inputFor(s) + '</div>' +
          srcBadge + resetBtn +
        '</div>';
      }).join('');
      return '<div style="margin-bottom:24px"><div class="card-title" style="margin-bottom:12px">' + icon + ' ' + cat.charAt(0).toUpperCase() + cat.slice(1) + '</div>' + rows + '</div>';
    }).join('');
  } catch (err) {
    P.setCardError('settings-content', 'Could not load settings', err);
  }
}

async function update(id, value) {
  try {
    const r = await P.apiFetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, value }),
    });
    const d = await r.json();
    if (d.ok) P.showToast(id + ' updated');
    else P.showToast('Failed: ' + (d.error || 'unknown'), false);
    load();
  } catch (_) {
    P.showToast('Error', false);
  }
}

async function reset(id) {
  try {
    const r = await P.apiFetch('/api/settings', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    const d = await r.json();
    if (d.ok) P.showToast(id + ' reset to default');
    load();
  } catch (_) {
    P.showToast('Error', false);
  }
}

function coerce(kind, raw) {
  if (kind === 'bool') return raw === 'true';
  if (kind === 'number') return Number(raw);
  return raw;
}

function mount(container) {
  root = container;
  root.innerHTML =
    '<div class="section-header"><div><h1 class="section-title">Settings</h1>' +
    '<div class="section-subtitle">Runtime configuration (DatabaseConfigProvider)</div></div></div>' +
    '<div class="card"><div id="settings-content"><div class="empty">Loading settings…</div></div></div>';
  root.addEventListener('change', (e) => {
    const field = e.target.closest('[data-op="update"]');
    if (field) update(field.dataset.id, coerce(field.dataset.kind, field.value));
  });
  root.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-op="reset"]');
    if (btn) reset(btn.dataset.id);
  });
}

let refreshTimer = null;

P.registerSection('settings', {
  mount,
  onShow() {
    load();
    if (!refreshTimer) refreshTimer = setInterval(() => { if (!document.hidden && root && root.classList.contains('active')) load(); }, 30000);
  },
});
