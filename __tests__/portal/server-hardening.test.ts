import { describe, expect, it, vi } from 'vitest';
import {
  createPortalSecurityHeadersMiddleware,
  isUnsafePublicPortalBind,
} from '../../src/portal/server';

describe('portal server hardening', () => {
  it('sets app-wide security headers before route handlers run', () => {
    const headers: Record<string, string> = {};
    const res = {
      setHeader: vi.fn((name: string, value: string) => {
        headers[name] = value;
      }),
    };
    const next = vi.fn();

    createPortalSecurityHeadersMiddleware()({} as any, res as any, next);

    expect(headers['Strict-Transport-Security']).toContain('max-age=31536000');
    expect(headers['X-Frame-Options']).toBe('DENY');
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
    expect(headers['Permissions-Policy']).toContain('camera=()');
    expect(headers['Content-Security-Policy']).toContain("default-src 'self'");
    expect(headers['Content-Security-Policy']).toContain("frame-ancestors 'none'");
    expect(next).toHaveBeenCalledOnce();
  });

  it('classifies wildcard bind addresses as unsafe for public hosts', () => {
    expect(isUnsafePublicPortalBind('0.0.0.0')).toBe(true);
    expect(isUnsafePublicPortalBind('::')).toBe(true);
    expect(isUnsafePublicPortalBind('127.0.0.1')).toBe(false);
    expect(isUnsafePublicPortalBind('localhost')).toBe(false);
  });
});
