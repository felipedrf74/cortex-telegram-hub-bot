import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const portalHtml = fs.readFileSync(
  path.join(process.cwd(), 'src', 'portal', 'portal.html'),
  'utf8',
);

describe('portal Cooking browser UI', () => {
  it('keeps the portal script syntactically valid', () => {
    const match = portalHtml.match(/<script>\n([\s\S]*)\n<\/script>/);
    expect(match?.[1]).toBeTruthy();
    expect(() => new Function(match?.[1] ?? '')).not.toThrow();
  });

  it('exposes a dedicated Cooking management section in portal navigation', () => {
    expect(portalHtml).toContain('data-nav="cooking"');
    expect(portalHtml).toContain('data-section="cooking"');
    expect(portalHtml).toContain("const SECTIONS = ['dashboard', 'alerts', 'users', 'ai', 'jobs', 'skills', 'content', 'cooking'");
    expect(portalHtml).toContain("if (section === 'cooking') renderCookingPortal()");
  });

  it('uses backend-authorized Cooking portal contracts instead of chat commands', () => {
    expect(portalHtml).toContain("'/api/users/' + target.userId + '/cooking/preferences'");
    expect(portalHtml).toContain("'/api/users/' + target.userId + '/cooking/pantry'");
    expect(portalHtml).toContain("'/api/users/' + target.userId + '/cooking/meal-plan/substitutions/apply'");
    expect(portalHtml).toContain("body: JSON.stringify({ tenantId: target.tenantId })");
    expect(portalHtml).not.toContain('/api/v1/chat');
    expect(portalHtml).not.toContain('memoryValue');
  });

  it('renders preference and pantry editors with destructive confirmation', () => {
    expect(portalHtml).toContain('id="cooking-preference-kind"');
    expect(portalHtml).toContain('id="cooking-preference-value"');
    expect(portalHtml).toContain('id="cooking-pantry-name"');
    expect(portalHtml).toContain('id="cooking-pantry-freshness"');
    expect(portalHtml).toContain("if (!confirm('Delete this Cooking pantry item?')) return");
    expect(portalHtml).toContain('openCookingManagerForUser');
  });

  it('renders an explicit reviewed substitution acceptance panel', () => {
    expect(portalHtml).toContain('id="cooking-substitution-date"');
    expect(portalHtml).toContain('id="cooking-substitution-meal-type"');
    expect(portalHtml).toContain('id="cooking-substitution-original"');
    expect(portalHtml).toContain('id="cooking-substitution-suggested"');
    expect(portalHtml).toContain('id="cooking-substitution-reason"');
    expect(portalHtml).toContain('id="cooking-substitution-update-shopping" checked');
    expect(portalHtml).toContain('id="cooking-apply-substitution-btn"');
    expect(portalHtml).toContain('applyCookingSubstitutionFromPortal');
    expect(portalHtml).toContain('reason,');
    expect(portalHtml).toContain('updateShoppingList,');
  });

  it('clears stale Cooking portal data after a scoped load failure', () => {
    expect(portalHtml).toContain("summary.textContent = 'Cooking preferences unavailable for this scoped request'");
    expect(portalHtml).toContain("list.innerHTML = '<div class=\"empty\">Failed to load Cooking preferences</div>'");
    expect(portalHtml).toContain("list.innerHTML = '<div class=\"empty\">Failed to load Cooking pantry</div>'");
    expect(portalHtml).toContain('preferences: null');
    expect(portalHtml).toContain('pantry: []');
  });
});
