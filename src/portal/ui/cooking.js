// Cooking tab — scoped preference review, pantry editor and substitution
// acceptance for one user/tenant, over the backend-authorized portal routes.
const P = window.NexusPortal;

const PREF_KINDS_NUMERIC = new Set(['weekday_max_prep_minutes', 'budget_limit']);
const PREF_KINDS_BOOLEAN = new Set(['batch_cooking_preferred']);
const SUBSTITUTION_HINT = 'Use this after a candidate is reviewed for allergy, dietary, disliked-ingredient, or pantry freshness safety.';

let root = null;
let state = { userId: null, tenantId: null, preferences: null, pantry: [], error: '', loading: false };

function el(id) { return root.querySelector('#' + id); }

function getTarget(quiet) {
  const userId = Number.parseInt(el('cooking-target-user-id').value || '', 10);
  const tenantId = Number.parseInt(el('cooking-target-tenant-id').value || el('cooking-target-user-id').value || '', 10);
  if (!Number.isInteger(userId) || userId <= 0 || !Number.isInteger(tenantId) || tenantId <= 0) {
    if (!quiet) P.showToast('Enter a valid Cooking user ID', false);
    return null;
  }
  return { userId, tenantId };
}

function setScopeStatus(text, kind) {
  const node = el('cooking-scope-status');
  node.textContent = text;
  node.className = 'badge mono badge-' + (kind || 'neutral');
}

function prefsOf() { return (state.preferences && state.preferences.preferences) || state.preferences || {}; }

function updateKpis() {
  const prefs = prefsOf();
  const profile = prefs.profile || {};
  const memories = prefs.memories || [];
  const pantry = state.pantry || [];
  const allergies = Array.isArray(profile.allergies) ? profile.allergies : [];
  const restrictions = Array.isArray(profile.dietaryRestrictions) ? profile.dietaryRestrictions : [];
  const expired = pantry.filter((item) => item.freshness_status === 'expired' || item.freshnessStatus === 'expired').length;
  const badge = document.getElementById('nav-cooking-badge');
  if (badge) badge.textContent = (memories.length || pantry.length) ? String(memories.length + pantry.length) : '';
  el('cooking-kpi-preferences').textContent = P.fmtNum(memories.length);
  el('cooking-kpi-preferences-sub').textContent = memories.length ? 'metadata only' : 'scoped metadata';
  el('cooking-kpi-pantry').textContent = P.fmtNum(pantry.length);
  el('cooking-kpi-pantry-sub').textContent = expired ? expired + ' expired' : 'including expired';
  el('cooking-kpi-allergies').textContent = P.fmtNum(allergies.length);
  el('cooking-kpi-diet').textContent = P.fmtNum(restrictions.length);
}

function renderPreferences() {
  const prefs = prefsOf();
  const memories = prefs.memories || [];
  const meta = el('cooking-preferences-meta');
  const summary = el('cooking-preferences-summary');
  const list = el('cooking-preferences-list');
  if (!state.userId) {
    meta.textContent = 'Select a user to load Cooking preferences';
    summary.textContent = 'No preferences loaded';
    list.innerHTML = '<div class="empty">No Cooking preferences loaded</div>';
    return;
  }
  if (state.error) {
    meta.textContent = 'Load failed for user ' + state.userId + ' · tenant ' + state.tenantId;
    summary.textContent = 'Cooking preferences unavailable for this scoped request';
    list.innerHTML = '<div class="empty">Failed to load Cooking preferences</div>';
    return;
  }
  meta.textContent = 'User ' + state.userId + ' · tenant ' + state.tenantId;
  summary.textContent = prefs.summary || prefs.skillMemorySummary || 'No preference summary available';
  if (!memories.length) { list.innerHTML = '<div class="empty">No Cooking preference memories returned</div>'; return; }
  list.innerHTML = '<div class="u-ovx-auto"><table class="data-table"><thead><tr><th>Kind</th><th>Scope</th><th>Confidence</th><th>Freshness</th><th>Updated</th></tr></thead><tbody>' +
    memories.map((memory) => '<tr>' +
      '<td><span class="mono">' + P.esc(memory.memoryKey || memory.memoryType || 'preference') + '</span></td>' +
      '<td><span class="badge badge-neutral">' + P.esc(memory.scope || 'unknown') + '</span></td>' +
      '<td class="mono">' + P.esc(memory.confidence != null ? memory.confidence : '—') + '</td>' +
      '<td>' + P.esc(memory.freshnessStatus || memory.status || '—') + '</td>' +
      '<td class="text-muted">' + P.esc(memory.updatedAt ? P.relativeTime(memory.updatedAt) : '—') + '</td>' +
    '</tr>').join('') + '</tbody></table></div>';
}

function renderPantry() {
  const list = el('cooking-pantry-list');
  const meta = el('cooking-pantry-meta');
  const items = state.pantry || [];
  if (!state.userId) { meta.textContent = 'Select a user to load pantry state'; list.innerHTML = '<div class="empty">No pantry loaded</div>'; return; }
  if (state.error) { meta.textContent = 'Load failed for user ' + state.userId + ' · tenant ' + state.tenantId; list.innerHTML = '<div class="empty">Failed to load Cooking pantry</div>'; return; }
  meta.textContent = items.length + ' items · user ' + state.userId + ' · tenant ' + state.tenantId;
  if (!items.length) { list.innerHTML = '<div class="empty">No pantry items returned</div>'; return; }
  list.innerHTML = '<div class="u-ovx-auto"><table class="data-table"><thead><tr><th>Item</th><th>Quantity</th><th>Freshness</th><th>Expires</th><th></th></tr></thead><tbody>' +
    items.map((item) => {
      const freshness = item.freshness_status || item.freshnessStatus || 'unknown';
      const badgeClass = freshness === 'expired' ? 'badge-error' : freshness === 'aging' ? 'badge-warning' : 'badge-success';
      const qty = [item.quantity, item.unit].filter(Boolean).join(' ') || '—';
      return '<tr>' +
        '<td><div class="u-fw-600">' + P.esc(item.name || 'Unnamed item') + '</div><div class="u-fs-11 text-muted">' + P.esc(item.category || item.availability_status || item.availabilityStatus || '') + '</div></td>' +
        '<td class="mono">' + P.esc(qty) + '</td>' +
        '<td><span class="badge ' + badgeClass + '">' + P.esc(freshness) + '</span></td>' +
        '<td class="text-muted">' + P.esc(item.expires_at || item.expiresAt || '—') + '</td>' +
        '<td class="text-right"><button class="btn btn-xs btn-danger" data-op="delete-pantry" data-id="' + Number(item.id) + '">Delete</button></td>' +
      '</tr>';
    }).join('') + '</tbody></table></div>';
}

function setSubstitutionResult(message, kind) {
  const status = el('cooking-substitution-status');
  status.textContent = kind === 'success' ? 'Applied' : kind === 'error' ? 'Failed' : 'Ready';
  status.className = 'badge badge-' + (kind || 'neutral');
  el('cooking-substitution-result').textContent = message;
}

function render() {
  if (!getTarget(true) && !state.userId) setScopeStatus('No user selected');
  if (state.loading) setScopeStatus('Loading…', 'neutral');
  else if (state.error) setScopeStatus('Load failed', 'error');
  else if (state.userId) setScopeStatus('User ' + state.userId + ' · tenant ' + state.tenantId, 'success');
  updateKpis();
  renderPreferences();
  renderPantry();
}

async function load() {
  const target = getTarget();
  if (!target) return;
  state = { ...state, ...target, loading: true, error: '' };
  render();
  const query = '?tenantId=' + encodeURIComponent(String(target.tenantId));
  try {
    const [preferencesRes, pantryRes] = await Promise.all([
      P.apiFetch('/api/users/' + target.userId + '/cooking/preferences' + query),
      P.apiFetch('/api/users/' + target.userId + '/cooking/pantry' + query + '&includeExpired=true&limit=250'),
    ]);
    const preferences = await preferencesRes.json();
    const pantry = await pantryRes.json();
    if (!preferencesRes.ok) throw new Error((preferences && preferences.error && preferences.error.message) || 'Cooking preferences load failed');
    if (!pantryRes.ok) throw new Error((pantry && pantry.error && pantry.error.message) || 'Cooking pantry load failed');
    state = { ...state, ...target, preferences, pantry: pantry.items || [], error: '', loading: false };
    render();
  } catch (err) {
    state = { ...state, ...target, preferences: null, pantry: [], error: (err && err.message) || 'Cooking portal load failed', loading: false };
    render();
    P.showToast(state.error, false);
  }
}

function coercePreferenceValue(kind, raw) {
  const trimmed = String(raw == null ? '' : raw).trim();
  if (PREF_KINDS_NUMERIC.has(kind)) return Number(trimmed);
  if (PREF_KINDS_BOOLEAN.has(kind)) return ['true', 'yes', '1', 'on'].includes(trimmed.toLowerCase());
  return trimmed;
}

async function postJson(path, body) {
  const res = await P.apiFetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

async function savePreference() {
  const target = getTarget();
  if (!target) return;
  const kind = el('cooking-preference-kind').value;
  const rawValue = el('cooking-preference-value').value;
  if (!String(rawValue || '').trim()) { P.showToast('Enter a Cooking preference value', false); return; }
  const btn = el('cooking-save-preference-btn');
  btn.disabled = true;
  try {
    const { res, data } = await postJson('/api/users/' + target.userId + '/cooking/preferences', {
      tenantId: target.tenantId, kind, value: coercePreferenceValue(kind, rawValue),
      correction: el('cooking-preference-correction').checked, source: 'portal_browser', confidence: 0.9,
    });
    if (!res.ok) throw new Error((data.error && data.error.message) || 'Preference write failed');
    el('cooking-preference-value').value = '';
    P.showToast('Cooking preference saved');
    await load();
  } catch (err) {
    P.showToast((err && err.message) || 'Cooking preference write failed', false);
  } finally {
    btn.disabled = false;
  }
}

const PANTRY_FIELDS = ['cooking-pantry-name', 'cooking-pantry-quantity', 'cooking-pantry-unit', 'cooking-pantry-category', 'cooking-pantry-expires-at', 'cooking-pantry-freshness', 'cooking-pantry-notes'];

async function savePantry() {
  const target = getTarget();
  if (!target) return;
  const name = el('cooking-pantry-name').value.trim();
  if (!name) { P.showToast('Enter a pantry item name', false); return; }
  const btn = el('cooking-save-pantry-btn');
  btn.disabled = true;
  try {
    const { res, data } = await postJson('/api/users/' + target.userId + '/cooking/pantry', {
      tenantId: target.tenantId, name,
      quantity: el('cooking-pantry-quantity').value.trim(), unit: el('cooking-pantry-unit').value.trim(),
      category: el('cooking-pantry-category').value.trim(), expiresAt: el('cooking-pantry-expires-at').value,
      freshnessStatus: el('cooking-pantry-freshness').value, notes: el('cooking-pantry-notes').value.trim(), confidence: 0.9,
    });
    if (!res.ok) throw new Error((data.error && data.error.message) || 'Pantry write failed');
    PANTRY_FIELDS.forEach((id) => { el(id).value = ''; });
    P.showToast('Pantry item saved');
    await load();
  } catch (err) {
    P.showToast((err && err.message) || 'Pantry write failed', false);
  } finally {
    btn.disabled = false;
  }
}

async function applyCookingSubstitutionFromPortal() {
  const target = getTarget();
  if (!target) return;
  const date = el('cooking-substitution-date').value;
  const mealType = el('cooking-substitution-meal-type').value;
  const originalIngredient = el('cooking-substitution-original').value.trim();
  const suggestedIngredient = el('cooking-substitution-suggested').value.trim();
  const reason = el('cooking-substitution-reason').value;
  const updateShoppingList = el('cooking-substitution-update-shopping').checked;
  if (!date || !mealType || !originalIngredient || !suggestedIngredient) {
    P.showToast('Enter meal date, meal type, original ingredient, and substitute', false);
    setSubstitutionResult('Missing required substitution fields.', 'error');
    return;
  }
  const btn = el('cooking-apply-substitution-btn');
  btn.disabled = true;
  setSubstitutionResult('Applying substitution for user ' + target.userId + ' · tenant ' + target.tenantId + '…');
  try {
    const { res, data } = await postJson('/api/users/' + target.userId + '/cooking/meal-plan/substitutions/apply', {
      tenantId: target.tenantId, date, mealType, originalIngredient, suggestedIngredient, reason, updateShoppingList,
    });
    if (!res.ok) throw new Error((data.error && data.error.message) || 'Substitution apply failed');
    const substitution = (data.result && data.result.substitution) || {};
    setSubstitutionResult('Applied ' + originalIngredient + ' → ' + suggestedIngredient + ' for ' + mealType + ' on ' + date + (substitution.shoppingListUpdated ? '; shopping list refreshed.' : '; shopping list unchanged.'), 'success');
    P.showToast('Cooking substitution applied');
    await load();
  } catch (err) {
    const message = (err && err.message) || 'Cooking substitution apply failed';
    setSubstitutionResult(message, 'error');
    P.showToast(message, false);
  } finally {
    btn.disabled = false;
  }
}

async function deletePantryItem(itemId) {
  const target = getTarget();
  if (!target || !itemId) return;
  if (!confirm('Delete this Cooking pantry item?')) return;
  try {
    const res = await P.apiFetch('/api/users/' + target.userId + '/cooking/pantry/' + encodeURIComponent(String(itemId)), {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tenantId: target.tenantId }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data.error && data.error.message) || 'Pantry delete failed');
    P.showToast('Pantry item deleted');
    await load();
  } catch (err) {
    P.showToast((err && err.message) || 'Pantry delete failed', false);
  }
}

function clearScope() {
  el('cooking-target-user-id').value = '';
  el('cooking-target-tenant-id').value = '';
  state = { userId: null, tenantId: null, preferences: null, pantry: [], error: '', loading: false };
  setSubstitutionResult(SUBSTITUTION_HINT);
  render();
}

// Called from the Users drawer ("Open in Cooking") through the section registry.
function openForUser(userId) {
  el('cooking-target-user-id').value = String(userId);
  el('cooking-target-tenant-id').value = String(userId);
  load();
}

const FIELD = 'u-w-100p u-p-8-10 u-r-radius-sm u-b-1-solid-border u-bg-bg-tertiary u-c-text-primary';
const CELL = 'u-p-7-10 u-r-radius-sm u-b-1-solid-border u-bg-bg-tertiary u-c-text-primary';
function options(list) { return list.map(([v, l]) => '<option value="' + v + '">' + l + '</option>').join(''); }
function kpi(label, id, sub, subId) { return '<div class="kpi-card"><div class="kpi-label">' + label + '</div><div class="kpi-value" id="' + id + '">—</div><div class="kpi-sub"' + (subId ? ' id="' + subId + '"' : '') + '>' + sub + '</div></div>'; }

function mount(container) {
  root = container;
  root.innerHTML =
    '<div class="section-header"><div><h1 class="section-title">Cooking</h1>' +
    '<div class="section-subtitle">Scoped preference review, pantry management, and Cooking setup diagnostics</div></div>' +
    '<div class="section-actions"><button class="btn btn-ghost btn-sm" id="cooking-refresh-btn">Refresh</button></div></div>' +
    '<div class="u-mb-space-4 card"><div class="card-header"><div><div class="card-title">Target Scope</div>' +
    '<span class="card-subtitle">Portal access is backend-authorized; current operator scoping requires tenant ID to match user ID.</span></div>' +
    '<span class="badge badge-neutral mono" id="cooking-scope-status">No user selected</span></div>' +
    '<div class="u-gap-space-3 u-ai-end grid grid-cols-4">' +
    '<div><label class="label" for="cooking-target-user-id">User ID</label><input type="number" min="1" id="cooking-target-user-id" placeholder="42" class="' + FIELD + '"></div>' +
    '<div><label class="label" for="cooking-target-tenant-id">Tenant ID</label><input type="number" min="1" id="cooking-target-tenant-id" placeholder="same as user" class="' + FIELD + '"></div>' +
    '<div><button class="u-w-100p btn btn-sm" id="cooking-load-btn">Load Cooking</button></div>' +
    '<div><button class="u-w-100p btn btn-ghost btn-sm" id="cooking-clear-btn">Clear</button></div></div></div>' +
    '<div class="u-mb-space-4 grid grid-cols-4">' +
    kpi('Preference memories', 'cooking-kpi-preferences', 'scoped metadata', 'cooking-kpi-preferences-sub') + kpi('Pantry items', 'cooking-kpi-pantry', 'including expired', 'cooking-kpi-pantry-sub') +
    kpi('Allergies', 'cooking-kpi-allergies', 'from read model') + kpi('Diet rules', 'cooking-kpi-diet', 'restrictions') + '</div>' +
    '<div class="u-mb-space-4 grid grid-cols-2">' +
    '<div class="card"><div class="card-header"><div><div class="card-title">Preference Review</div><span class="card-subtitle" id="cooking-preferences-meta">Select a user to load Cooking preferences</span></div></div>' +
    '<div class="u-p-space-3 u-bb-1-solid-border"><div class="u-d-grid u-cols-1fr-1-4fr-auto-auto u-gap-space-2 u-ai-end">' +
    '<div><label class="label" for="cooking-preference-kind">Kind</label><select id="cooking-preference-kind" class="' + FIELD + '">' +
    options([['allergy', 'Allergy'], ['dietary_restriction', 'Dietary restriction'], ['disliked_ingredient', 'Disliked ingredient'], ['preferred_ingredient', 'Preferred ingredient'], ['equipment', 'Equipment'], ['weekday_max_prep_minutes', 'Weekday prep minutes'], ['budget_limit', 'Budget limit'], ['budget_currency', 'Budget currency'], ['batch_cooking_preferred', 'Batch cooking preferred'], ['training_day_preference', 'Training day preference'], ['cooking_skill_level', 'Cooking skill level'], ['grocery_preference', 'Grocery preference']]) +
    '</select></div>' +
    '<div><label class="label" for="cooking-preference-value">Value</label><input type="text" id="cooking-preference-value" placeholder="peanuts, 20, true…" class="' + FIELD + '"></div>' +
    '<label class="u-gap-6 u-ws-nowrap u-pb-8 flex items-center"><input type="checkbox" id="cooking-preference-correction" checked><span class="u-fs-12 text-muted">Correction</span></label>' +
    '<button class="btn btn-sm" id="cooking-save-preference-btn">Save</button></div></div>' +
    '<div class="u-p-space-3 u-bb-1-solid-border"><div class="u-fs-11 u-tt-uppercase u-ls-04em u-mb-space-2 text-muted">Summary</div>' +
    '<div id="cooking-preferences-summary" class="u-fs-12 u-lh-1-5 u-c-text-secondary">No preferences loaded</div></div>' +
    '<div id="cooking-preferences-list"><div class="empty">No Cooking preferences loaded</div></div></div>' +
    '<div class="card"><div class="card-header"><div><div class="card-title">Pantry Editor</div><span class="card-subtitle" id="cooking-pantry-meta">Select a user to load pantry state</span></div></div>' +
    '<div class="u-p-space-3 u-bb-1-solid-border">' +
    '<div class="u-d-grid u-cols-1-5fr-7fr-7fr-1fr u-gap-space-2 u-mb-space-2">' +
    '<input type="text" id="cooking-pantry-name" placeholder="Ingredient" class="' + CELL + '"><input type="text" id="cooking-pantry-quantity" placeholder="Qty" class="' + CELL + '">' +
    '<input type="text" id="cooking-pantry-unit" placeholder="Unit" class="' + CELL + '"><input type="text" id="cooking-pantry-category" placeholder="Category" class="' + CELL + '"></div>' +
    '<div class="u-d-grid u-cols-1fr-1fr-1-5fr-auto u-gap-space-2">' +
    '<input type="date" id="cooking-pantry-expires-at" class="' + CELL + '">' +
    '<select id="cooking-pantry-freshness" class="' + CELL + '">' + options([['', 'Freshness'], ['fresh', 'Fresh'], ['aging', 'Aging'], ['expired', 'Expired'], ['unknown', 'Unknown']]) + '</select>' +
    '<input type="text" id="cooking-pantry-notes" placeholder="Notes" class="' + CELL + '"><button class="btn btn-sm" id="cooking-save-pantry-btn">Save item</button></div></div>' +
    '<div id="cooking-pantry-list"><div class="empty">No pantry loaded</div></div></div></div>' +
    '<div class="u-mb-space-4 card"><div class="card-header"><div><div class="card-title">Substitution Acceptance</div>' +
    '<span class="card-subtitle">Apply an already-reviewed safe substitution to a scoped meal, linked recipe, and optional shopping list.</span></div>' +
    '<span class="badge badge-neutral" id="cooking-substitution-status">No substitution applied</span></div>' +
    '<div class="u-p-space-3 u-bb-1-solid-border"><div class="u-d-grid u-cols-1fr-1fr-1-1fr-1-1fr-1-2fr-auto u-gap-space-2 u-ai-end">' +
    '<div><label class="label" for="cooking-substitution-date">Meal date</label><input type="date" id="cooking-substitution-date" class="' + FIELD + '"></div>' +
    '<div><label class="label" for="cooking-substitution-meal-type">Meal type</label><select id="cooking-substitution-meal-type" class="' + FIELD + '">' + options([['breakfast', 'Breakfast'], ['lunch', 'Lunch'], ['dinner', 'Dinner'], ['snack', 'Snack']]) + '</select></div>' +
    '<div><label class="label" for="cooking-substitution-original">Original ingredient</label><input type="text" id="cooking-substitution-original" placeholder="peanuts" class="' + FIELD + '"></div>' +
    '<div><label class="label" for="cooking-substitution-suggested">Suggested ingredient</label><input type="text" id="cooking-substitution-suggested" placeholder="sunflower seeds" class="' + FIELD + '"></div>' +
    '<div><label class="label" for="cooking-substitution-reason">Reason</label><select id="cooking-substitution-reason" class="' + FIELD + '">' + options([['allergy', 'Allergy'], ['dietary_restriction', 'Dietary restriction'], ['disliked_ingredient', 'Disliked ingredient'], ['expired_pantry', 'Expired pantry']]) + '</select></div>' +
    '<button class="btn btn-sm" id="cooking-apply-substitution-btn">Apply</button></div>' +
    '<label class="u-gap-6 u-mt-space-3 u-ws-nowrap flex items-center"><input type="checkbox" id="cooking-substitution-update-shopping" checked><span class="u-fs-12 text-muted">Refresh the scoped shopping list after applying</span></label></div>' +
    '<div id="cooking-substitution-result" class="u-p-space-3 u-fs-12 u-c-text-secondary">' + SUBSTITUTION_HINT + '</div></div>';

  el('cooking-refresh-btn').addEventListener('click', load);
  el('cooking-load-btn').addEventListener('click', load);
  el('cooking-clear-btn').addEventListener('click', clearScope);
  el('cooking-save-preference-btn').addEventListener('click', savePreference);
  el('cooking-save-pantry-btn').addEventListener('click', savePantry);
  el('cooking-apply-substitution-btn').addEventListener('click', applyCookingSubstitutionFromPortal);
  root.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-op="delete-pantry"]');
    if (btn) deletePantryItem(Number(btn.dataset.id));
  });
}

P.registerSection('cooking', {
  mount,
  onShow() { render(); },
  openForUser,
});
