import { describe, expect, it } from 'vitest';
import { createPortalUiHarness } from './helpers/portal-ui-module-harness';

/**
 * The web sign-in page (/user, /login, /app) hides the provider panel with the
 * `hidden` attribute (user-login.html + `#provider-panel[hidden]` in
 * user-login.css). Its script must toggle that attribute, not inline display:
 * a display-only toggle leaves `hidden` in place and the Apple / Google tab
 * shows an empty card.
 */

function loadSignInPage() {
  const harness = createPortalUiHarness();
  // Markup state on first paint: provider panel hidden, email form visible.
  harness.el('provider-panel').hidden = true;
  harness.el('email-form').hidden = false;
  harness.load('user-login.js');
  return harness;
}

describe('user-login page tabs', () => {
  it('the Apple / Google tab clears hidden on the provider panel and hides the email form', () => {
    const harness = loadSignInPage();
    harness.trigger(harness.el('tab-provider'), 'click');
    expect(harness.el('provider-panel').hidden).toBe(false);
    expect(harness.el('email-form').hidden).toBe(true);
    expect(harness.el('tab-provider').classList.contains('active')).toBe(true);
    expect(harness.el('tab-email').classList.contains('active')).toBe(false);
  });

  it('the Email tab restores the email form and hides the provider panel again', () => {
    const harness = loadSignInPage();
    harness.trigger(harness.el('tab-provider'), 'click');
    harness.trigger(harness.el('tab-email'), 'click');
    expect(harness.el('email-form').hidden).toBe(false);
    expect(harness.el('provider-panel').hidden).toBe(true);
  });

  it('does not fall back to inline display toggles the CSS rule cannot see', () => {
    const harness = loadSignInPage();
    harness.trigger(harness.el('tab-provider'), 'click');
    expect(harness.el('provider-panel').style.display).toBeUndefined();
    expect(harness.el('email-form').style.display).toBeUndefined();
  });
});
