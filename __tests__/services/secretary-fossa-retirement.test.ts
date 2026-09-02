import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../..');

function read(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), 'utf8');
}

describe('retired Secretary Fossa automation', () => {
  it('keeps the owner-specific job, environment switches, notification facts, and PII out of active runtime code', () => {
    const activeRuntime = [
      read('src/services/scheduler.ts'),
      read('src/skills/skill-config.ts'),
      read('config/agent-job-manifest.json'),
      read('.env.example'),
    ].join('\n');

    expect(activeRuntime).not.toMatch(/fossa_email|FOSSA_EMAIL_(?:ENABLED|TO)/i);
    expect(activeRuntime).not.toMatch(/todayNotifications|getTodayNotifications/);
    expect(activeRuntime).not.toMatch(/@mun-montijo\.pt|N[uú]mero de Cliente|Morada:/i);
    expect(activeRuntime).not.toMatch(/\b(?:\+351\s*)?9\d{2}(?:\s*\d{3}){2}\b/);
  });

  it('retains only tenant-neutral retirement metadata outside the historical migration', () => {
    const retirementSql = read('migrations/310_retire_fossa_email_metadata.sql');

    expect(retirementSql).toContain("source = 'retired_secretary_automation'");
    expect(retirementSql).toContain("recipient = '[redacted]'");
    expect(retirementSql).not.toMatch(/@mun-montijo\.pt|N[uú]mero de Cliente|Morada:/i);
    expect(retirementSql).not.toMatch(/\b(?:\+351\s*)?9\d{2}(?:\s*\d{3}){2}\b/);
  });
});
