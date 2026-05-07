import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '..', '..');

function read(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

describe('notification orchestrator security invariants', () => {
  it('keeps arbitrary notification intent creation behind the internal skill secret', () => {
    const routes = read('src/api/routes/notifications.ts');
    expect(routes).toContain('secureSecretMatches');
    expect(routes).toContain('Notification intent creation requires an internal skill context');
    expect(routes).toContain("router.post('/intents'");
  });

  it('keeps lock-screen payloads privacy-safe for sensitive skills', () => {
    const service = read('src/services/notification-orchestrator.ts');
    expect(service).toContain('Finance reminder needs review.');
    expect(service).toContain('Training check-in needed.');
    expect(service).toContain('Content item is ready for review.');
    expect(service).toContain('buildPrivacySafeBody');
  });

  it('stores notification device-token metadata by hash, not raw token', () => {
    const service = read('src/services/notification-orchestrator.ts');
    const deviceTokenInsert = service.slice(
      service.indexOf('INSERT INTO notification_device_tokens'),
      service.indexOf('const row = db.prepare', service.indexOf('INSERT INTO notification_device_tokens')),
    );
    expect(deviceTokenInsert).toContain('token_hash');
    expect(deviceTokenInsert).not.toContain('push_token');
  });
});
