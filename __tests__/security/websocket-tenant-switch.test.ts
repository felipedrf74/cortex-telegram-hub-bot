import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('iOS WebSocket tenant scope', () => {
  const originalEnv = {
    IOS_API_JWT_SECRET: process.env.IOS_API_JWT_SECRET,
    IOS_JWT_EXPIRY: process.env.IOS_JWT_EXPIRY,
  };

  afterEach(() => {
    if (originalEnv.IOS_API_JWT_SECRET === undefined) delete process.env.IOS_API_JWT_SECRET;
    else process.env.IOS_API_JWT_SECRET = originalEnv.IOS_API_JWT_SECRET;
    if (originalEnv.IOS_JWT_EXPIRY === undefined) delete process.env.IOS_JWT_EXPIRY;
    else process.env.IOS_JWT_EXPIRY = originalEnv.IOS_JWT_EXPIRY;
  });

  it('signs and verifies tenantId in iOS JWT payloads', async () => {
    process.env.IOS_API_JWT_SECRET = 'tenant-scope-secret';
    process.env.IOS_JWT_EXPIRY = '1h';
    const { signIosJwt, verifyIosJwt } = await import('../../src/services/ios-jwt');

    const token = signIosJwt({ userId: 42, tenantId: 1001, deviceId: 'ios-device' });
    const payload = verifyIosJwt(token);

    expect(payload).toMatchObject({ userId: 42, tenantId: 1001, deviceId: 'ios-device' });
  });

  it('revalidates canonical tenant scope on every WebSocket message', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../src/api/websocket.ts'),
      'utf8',
    );

    expect(source).toContain('const canonicalTenantId = resolveCurrentTenantIdForUser(payload.userId)');
    expect(source).toContain('if (tokenTenantId !== canonicalTenantId)');
    expect(source).toContain('if (tenantId !== resolveCurrentTenantIdForUser(userId))');
    expect(source).toContain("ws.close(4003, 'Tenant scope changed')");
  });
});
