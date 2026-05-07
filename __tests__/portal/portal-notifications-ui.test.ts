import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const portalHtml = fs.readFileSync(
  path.join(process.cwd(), 'src', 'portal', 'portal.html'),
  'utf8',
);

describe('portal Notification Decision Center UI', () => {
  it('keeps the portal script syntactically valid', () => {
    const match = portalHtml.match(/<script>\n([\s\S]*)\n<\/script>/);
    expect(match?.[1]).toBeTruthy();
    expect(() => new Function(match?.[1] ?? '')).not.toThrow();
  });

  it('exposes a dedicated notification center section and loader', () => {
    expect(portalHtml).toContain('data-nav="notifications"');
    expect(portalHtml).toContain('data-section="notifications"');
    expect(portalHtml).toContain('id="notification-center-content"');
    expect(portalHtml).toContain('id="notification-preferences-content"');
    expect(portalHtml).toContain("if (section === 'notifications') loadNotificationPortal()");
  });

  it('loads portal-safe notification center and preference contracts', () => {
    expect(portalHtml).toContain("apiJson('/api/notifications?limit=100')");
    expect(portalHtml).toContain("apiJson('/api/notification-preferences?limit=100')");
    expect(portalHtml).toContain('function isNotificationScopedRoute(url)');
    expect(portalHtml).toContain('center.decisionCenterItems || []');
    expect(portalHtml).toContain('Safe preview');
    expect(portalHtml).not.toContain('sensitiveBody');
  });
});
