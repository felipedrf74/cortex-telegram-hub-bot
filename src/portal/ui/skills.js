// Skills — global toggles, per-user overrides, domain status
// Extracted from legacy.js (Phase 5 section extraction). The markup stays in
// portal.html; this module owns the section's data loading and rendering and
// talks to the shell through window.NexusPortal (fetch wrapper, helpers,
// section registry, event bus: app:start / refresh / poll / snapshot).
const P = window.NexusPortal;
const { apiFetch, apiJson, esc, shortDateTime, relativeTime, fmtNum, fmtCost, showToast, adminLoadErrorMessage } = P;
const navigateTo = (section) => P.navigateTo(section);
let allUsers = [];

function renderDomainStatus(domains) {
  const el = document.getElementById('domain-status-content');
  if (!domains || domains.length === 0) {
    el.innerHTML = '<div class="empty">No domain data</div>';
    return;
  }
  el.innerHTML = '<div class="u-gap-space-3 grid grid-cols-auto">' + domains.map(d => {
    const dot = d.active ? 'online' : 'offline';
    return '<div class="provider-card">' +
      '<div class="provider-card-header">' +
        '<div class="provider-name"><span class="u-mr-8 status-dot ' + dot + '"></span>' + esc(d.label || d.domain) + '</div>' +
        '<span class="domain-tag domain-' + esc(d.domain) + '">' + esc(d.domain) + '</span>' +
      '</div>' +
      '<div class="provider-stats">' +
        '<div>Today: <b>' + (d.messagesToday || 0) + '</b></div>' +
        '<div>Total: <b>' + (d.totalMessages || 0) + '</b></div>' +
        '<div class="u-col-span-2">Last: <b>' + (d.lastMessageAt ? relativeTime(d.lastMessageAt) : '—') + '</b></div>' +
      '</div>' +
      '</div>';
  }).join('') + '</div>';
}

// Skills scope state. When _skillsScopeUserId is null we're in global
// mode (the historical behavior) and toggles go to /api/skills/toggle.
// When it's a user id, we render the per-user override view and
// toggles go to /api/users/:id/skills (which layers on top of the
// global state). The scope is switched via the dropdown above the grid.
let _skillsScopeUserId = null;

function renderSkillsGrid(skills) {
  const el = document.getElementById('skills-grid');
  if (!skills || skills.length === 0) {
    el.innerHTML = '<div class="empty">No skills loaded</div>';
    return;
  }

  // Normalize shape so we can reuse the renderer for both:
  //   global  (from /api/snapshot.skillStatus)  — fields: name, subSkills[].name, subSkills[].description, subSkills[].toolCount
  //   per-user (from /api/users/:id/skills)     — fields: skill, subSkills[].id, subSkills[].label, no toolCount
  const normalized = skills.map(s => ({
    key: s.name || s.skill,
    label: s.label || s.name || s.skill,
    description: s.description || '',
    enabled: s.enabled,
    source: s.source || 'default',
    subSkills: (s.subSkills || []).map(sub => ({
      key: sub.name || sub.id,
      label: sub.description || sub.label || sub.name || sub.id,
      enabled: sub.enabled,
      source: sub.source || 'default',
      toolCount: sub.toolCount,
    })),
  }));

  el.innerHTML = normalized.map(s => {
    const subs = s.subSkills.map(sub => {
      const onChange = 'data-on="change" data-act="onSkillToggle" data-args="[&quot;' + esc(s.key) + '&quot;,&quot;' + esc(sub.key) + '&quot;,&quot;$checked&quot;]"';
      const overrideBadge = sub.source === 'override'
        ? '<span class="u-fs-9 u-ml-4 badge badge-accent">override</span>'
        : '';
      const toolCount = sub.toolCount != null
        ? '<span class="u-ml-auto u-fs-10 text-tertiary mono">' + sub.toolCount + ' tools</span>'
        : '';
      return '<div class="sub-skill">' +
        '<label class="toggle">' +
          '<input type="checkbox" ' + (sub.enabled ? 'checked' : '') + ' ' + onChange + '>' +
          '<span class="toggle-track"><span class="toggle-thumb"></span></span>' +
        '</label>' +
        '<span class="toggle-label">' + esc(sub.label) + '</span>' +
        overrideBadge +
        toolCount +
      '</div>';
    }).join('');
    const masterChange = 'data-on="change" data-act="onSkillToggle" data-args="[&quot;' + esc(s.key) + '&quot;,null,&quot;$checked&quot;]"';
    const masterBadge = s.source === 'override'
      ? '<span class="u-fs-9 u-ml-4 badge badge-accent">override</span>'
      : '';
    return '<div class="skill-card">' +
      '<div class="skill-header">' +
        '<span class="skill-icon">🧩</span>' +
        '<span class="skill-name">' + esc(s.label) + '</span>' +
        masterBadge +
        '<label class="toggle">' +
          '<input type="checkbox" ' + (s.enabled ? 'checked' : '') + ' ' + masterChange + '>' +
          '<span class="toggle-track"><span class="toggle-thumb"></span></span>' +
        '</label>' +
      '</div>' +
      '<div class="u-fs-11 u-mb-8 text-muted">' + esc(s.description) + '</div>' +
      subs +
      '</div>';
  }).join('');
}

// Populate the user selector dropdown with registered users (from
// /api/users). Called when the Skills section becomes visible.
async function loadSkillsUserSelector() {
  try {
    if (!allUsers || allUsers.length === 0) {
      const r = await apiFetch('/api/users');
      if (r.ok) {
        const d = await r.json();
        allUsers = d.users || [];
      }
    }
    const sel = document.getElementById('skills-user-select');
    if (!sel) return;
    // Keep the "Global" option at index 0 and append users after it
    const currentValue = sel.value;
    sel.innerHTML = '<option value="global">🌐 Global (affects all users)</option>' +
      allUsers.map(u => {
        const label = [u.first_name || '', u.last_name || ''].filter(Boolean).join(' ').trim()
          || u.username
          || ('#' + u.id);
        return '<option value="' + esc(String(u.id)) + '">👤 ' + esc(label) + ' (' + esc(String(u.id)) + ')</option>';
      }).join('');
    // Restore the previously-selected value across reloads
    if (currentValue && sel.querySelector('option[value="' + currentValue + '"]')) {
      sel.value = currentValue;
    }
  } catch { /* silent — Skills page still works with just Global */ }
}

// Wired to the dropdown onchange. Switches the scope state and
// re-renders the grid from the appropriate data source.
window.onSkillsUserChange = function(sel) {
  const val = sel.value;
  const resetBtn = document.getElementById('skills-reset-user');
  const hint = document.getElementById('skills-scope-hint');
  const subtitle = document.getElementById('skills-subtitle');

  if (val === 'global') {
    _skillsScopeUserId = null;
    if (resetBtn) resetBtn.hidden = true;
    if (hint) hint.textContent = 'Toggles here affect ALL users. Pick a user to set per-user overrides.';
    if (subtitle) subtitle.textContent = 'Skill packages and sub-skill toggles';
    // The snapshot poller picks up skillStatus, so we just force a
    // fresh render from the cached snapshot. If the cache is empty
    // we re-fetch the snapshot directly.
    P.emit('refresh');
  } else {
    _skillsScopeUserId = parseInt(val, 10);
    if (resetBtn) resetBtn.hidden = false;
    if (hint) hint.textContent = 'Showing per-user overrides. Toggles affect ONLY this user.';
    if (subtitle) subtitle.textContent = 'Per-user skill overrides — user ID ' + _skillsScopeUserId;
    loadUserSkills(_skillsScopeUserId);
  }
};

async function loadUserSkills(userId) {
  try {
    const r = await apiFetch('/api/users/' + userId + '/skills');
    if (!r.ok) return;
    const d = await r.json();
    renderSkillsGrid(d.skills || []);
  } catch { /* silent */ }
}

window.resetSelectedUserSkills = async function() {
  if (!_skillsScopeUserId) return;
  if (!confirm('Reset all skill overrides for user ' + _skillsScopeUserId + '?\n\nThis reverts every skill and sub-skill back to the global default for this user.')) return;
  try {
    const r = await apiFetch('/api/users/' + _skillsScopeUserId + '/skills/reset', { method: 'POST' });
    if (r.ok) {
      showToast('User overrides reset');
      loadUserSkills(_skillsScopeUserId);
    }
  } catch { showToast('Reset failed', false); }
};

// Dispatcher called by both master-skill and sub-skill checkboxes in the
// rendered grid. Routes to the right backend endpoint based on scope.
//
//   subSkill = null  → master-skill toggle
//   subSkill ≠ null  → sub-skill toggle
window.onSkillToggle = async function(skill, subSkill, enabled) {
  try {
    if (_skillsScopeUserId) {
      // Per-user override
      const r = await apiFetch('/api/users/' + _skillsScopeUserId + '/skills', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skill, subSkill: subSkill || undefined, enabled }),
      });
      if (r.ok) {
        showToast(skill + (subSkill ? ':' + subSkill : '') + (enabled ? ' enabled' : ' disabled') + ' for user');
        loadUserSkills(_skillsScopeUserId);
      } else {
        showToast('Toggle failed', false);
      }
    } else {
      // Global toggle — keep historical endpoint shapes
      if (subSkill) {
        const r = await apiFetch('/api/skills/toggle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ domain: skill, subSkill, enabled }),
        });
        const d = await r.json();
        if (d.ok) showToast(skill + ':' + subSkill + (enabled ? ' enabled' : ' disabled'));
        else showToast('Toggle failed', false);
      } else {
        const ep = '/api/skills/' + encodeURIComponent(skill) + (enabled ? '/enable' : '/disable');
        const r = await apiFetch(ep, { method: 'POST' });
        if (r.ok) showToast(skill + (enabled ? ' enabled' : ' disabled'));
        else showToast('Toggle failed', false);
      }
    }
  } catch { showToast('Toggle failed', false); }
};

// ════════════════════════════════════════════════════════════
// Skills (global toggle)
// ════════════════════════════════════════════════════════════
window.toggleSubSkill = async function(domain, subSkill, enabled) {
  try {
    const r = await apiFetch('/api/skills/toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain, subSkill, enabled }),
    });
    const d = await r.json();
    if (d.ok) showToast(domain + ':' + subSkill + (enabled ? ' enabled' : ' disabled'));
    else showToast('Toggle failed', false);
  } catch { showToast('Toggle failed', false); }
};
window.toggleSkillMaster = async function(skillName, enabled) {
  try {
    const ep = '/api/skills/' + encodeURIComponent(skillName) + (enabled ? '/enable' : '/disable');
    await apiFetch(ep, { method: 'POST' });
    showToast(skillName + (enabled ? ' enabled' : ' disabled'));
  } catch { showToast('Toggle failed', false); }
};

// Global view renders from every snapshot poll; a per-user scope keeps its own
// view and refreshes from the user endpoint instead.
P.on('snapshot', (snap) => {
  renderDomainStatus(snap.domainStatus || []);
  if (_skillsScopeUserId == null) renderSkillsGrid(snap.skillStatus || []);
  else loadUserSkills(_skillsScopeUserId);
});

P.registerSection('skills', {
  mount() {},
  onShow() { loadSkillsUserSelector(); },
});
