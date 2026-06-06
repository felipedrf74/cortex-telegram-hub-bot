import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const routerSource = fs.readFileSync(
  path.resolve(__dirname, '../../src/api/router.ts'),
  'utf8',
);

function mountPattern(method: 'get' | 'post' | 'use', mountPath: string): RegExp {
  const escapedPath = mountPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`router\\s*\\.\\s*${method}\\s*\\(\\s*['"\`]${escapedPath}['"\`]`, 'm');
}

describe('API router authorization boundary', () => {
  it('keeps user-scoped /api/v1 surfaces behind auth middleware', () => {
    const authIndex = routerSource.indexOf('router.use(authMiddleware);');
    expect(authIndex).toBeGreaterThan(0);

    const publicSection = routerSource.slice(0, authIndex);
    const protectedSection = routerSource.slice(authIndex);

    for (const publicMount of [
      "router.get('/'",
      "router.use('/auth'",
      "router.use('/internal'",
      "router.use('/admin/content-dashboard'",
      "router.use('/admin/content'",
      "router.use('/admin/event-backbone'",
      "router.post('/billing/apple-notifications'",
    ]) {
      const match = publicMount.match(/router\.(get|post|use)\('([^']+)'/);
      expect(match).not.toBeNull();
      expect(publicSection).toMatch(mountPattern(match?.[1] as 'get' | 'post' | 'use', match?.[2] ?? ''));
    }

    for (const scopedSurface of [
      '/chat',
      '/dashboard',
      '/tasks',
      '/training',
      '/calendar',
      '/connections',
      '/content',
      '/cooking',
      '/finance',
      '/settings',
      '/decisions',
      '/reports',
    ]) {
      expect(publicSection).not.toMatch(mountPattern('use', scopedSurface));
      expect(protectedSection).toMatch(mountPattern('use', scopedSurface));
    }

    expect(protectedSection).toContain('runWithContext({ requestId, source: \'http\', userId');
    expect(protectedSection).toContain("requireEntitlement({ skill: 'training' })");
    expect(protectedSection).toContain("requireEntitlement({ skill: 'content' })");
    expect(protectedSection).toContain("requireEntitlement({ skill: 'finance' })");
  });
});
