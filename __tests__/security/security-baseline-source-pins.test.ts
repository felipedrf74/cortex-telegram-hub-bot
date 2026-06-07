import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '../..');

function read(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

describe('Nexus security baseline source pins', () => {
  it('keeps the canonical threat model and control matrix wired into docs indexes', () => {
    const threatModel = read('docs/security/nexus-security-threat-model.md');
    const matrix = read('docs/security/security-control-matrix.md');
    const runbook = read('docs/security/security-operations-runbook.md');
    const implementationStatus = read('docs/security/security-hardening-implementation-status.md');
    const index = read('docs/DOCS_INDEX.md');
    const engineeringIndex = read('docs/engineering/ENGINEERING_STANDARDS_INDEX.md');

    for (const required of [
      'OWASP ASVS',
      'OWASP API Top 10',
      'OWASP MASVS',
      'NIST SP 800-63B',
      'multi-tenant BOLA',
      'SSRF',
      'provider-token compromise',
      'WebSocket',
      'iOS local data',
      'VPS exposure',
    ]) {
      expect(threatModel).toContain(required);
    }

    for (const surface of [
      '/api/v1',
      'Auth/session',
      'WebSocket /ws',
      'iOS storage',
      'Provider tokens',
      'Stripe/Apple billing',
      'Content engine',
      'SSRF/scraping',
      'Logs/Sentry',
      'CI/supply chain',
      'VPS/Cloudflare',
      'Incident/privacy',
    ]) {
      expect(matrix).toContain(surface);
    }

    expect(runbook).toContain('Cross-tenant data exposure');
    expect(runbook).toContain('Backup Protection And Restore Drill');
    expect(implementationStatus).toContain('There are no intentionally hidden open tasks');
    expect(implementationStatus).toContain('Original Plan Phase Coverage');
    expect(implementationStatus).toContain('Public Interface / Contract Coverage');
    expect(implementationStatus).toContain('Test Plan Coverage');
    expect(implementationStatus).toContain('Claude QA Follow-Up Closure');
    for (const closedFinding of [
      'P0 IPv6 SSRF bypass',
      'P2 `calendarText` Pino redaction gap',
      'P2 brittle route-boundary source pin',
      'P3 Scorecard OIDC permission',
    ]) {
      expect(implementationStatus).toContain(closedFinding);
    }
    for (const phase of [
      '1. Security baseline and control matrix',
      '2. Backend/API authorization inventory',
      '2. Auth/session hardening',
      '2. WebSocket hardening',
      '2. Provider/webhook hardening',
      '3. iOS/Mobile hardening',
      '4. Infrastructure, edge, and data protection',
      '5. Content engine, AI, SSRF, and tool safety',
      '6. Logging, Sentry, secrets, and privacy',
      '7. CI, supply chain, and release gates',
      '8. Incident response and privacy operations',
    ]) {
      expect(implementationStatus).toContain(phase);
    }
    for (const blockedItem of [
      'Cloudflare firewall/origin lock-down',
      'VPS UFW/fail2ban/SSH/systemd/PM2 permission changes',
      'Backup encryption/off-host copy/restore drill',
      'Secret rotation for JWT/provider/Stripe/Cloudflare/Resend/Telegram/model keys',
      'Route-by-route mass-assignment allowlist migration',
      'Step-up auth for destructive/sensitive actions',
      'Passkeys/WebAuthn owner/admin rollout',
      'SQLCipher or production DB-at-rest migration',
      'Real APNs payload privacy smoke',
      'Full iOS release-hardening suite',
      'Global `authAssuranceLevel`, `scopeSource`, `providerWriteVerified`, and `redactionApplied` metadata',
      'User-facing active sessions/devices, passkey enrollment, provider-token status, recent security activity, and revoke-all-sessions settings',
      'Backend mass-assignment tests for mutation routes',
      'APNs payload privacy tests',
    ]) {
      expect(implementationStatus).toContain(blockedItem);
    }
    for (const coveredItem of [
      'No breaking public API changes by default',
      'Internal `traceId` and verification metadata where already useful',
      'Backend route authorization/BOLA tests for scoped routes',
      'JWT/session/refresh rotation and replay tests',
      'WebSocket auth, tenant-scope, Origin, and rate tests',
      'Provider webhook signature, replay, and idempotency tests',
      'SSRF and Playwright isolation tests',
      'Sentry/Pino redaction tests',
      'iOS Keychain/accessibility and ATS/no-cleartext source pins',
      'iOS deep-link/OAuth state/nonce tests',
      'Manual hostile QA: two-account cross-tenant attempts, stolen/expired refresh token, provider revoked, malicious transcript/tool output, SSRF corpus, webhook replay, lost device/logout',
    ]) {
      expect(implementationStatus).toContain(coveredItem);
    }
    expect(implementationStatus.match(/BLOCKED_WITH_EXACT_REASON/g)?.length).toBeGreaterThanOrEqual(14);
    expect(index).toContain('docs/security/nexus-security-threat-model.md');
    expect(index).toContain('docs/security/security-control-matrix.md');
    expect(engineeringIndex).toContain('../security/security-control-matrix.md');
  });

  it('adds supply-chain security automation without broad workflow permissions', () => {
    const workflow = read('.github/workflows/security.yml');
    const dependabot = read('.github/dependabot.yml');

    expect(workflow).toMatch(/github\/codeql-action\/init@[a-f0-9]{40}\s+# v4/);
    expect(workflow).toContain('npm audit --audit-level=high');
    expect(workflow).toContain('pip-audit -r content-engine/requirements.txt');
    expect(workflow).toMatch(/ossf\/scorecard-action@[a-f0-9]{40}\s+# v2\.4\.3/);
    expect(workflow).toContain('permissions:');
    expect(workflow).not.toContain('contents: write');
    expect(workflow).not.toContain('pull-requests: write');
    expect(workflow).not.toContain('id-token: write');

    expect(dependabot).toContain('package-ecosystem: npm');
    expect(dependabot).toContain('package-ecosystem: pip');
    expect(dependabot).toContain('package-ecosystem: github-actions');
  });

  it('fails closed when chat access checks cannot be evaluated', () => {
    const restGate = read('src/api/routes/chat-message-tier-gate.ts');
    const websocket = read('src/api/websocket.ts');

    expect(restGate).toContain('ACCESS_CHECK_UNAVAILABLE');
    expect(restGate).toContain('iOS tier gate check failed — fail-closed');
    expect(websocket).toContain('ACCESS_CHECK_UNAVAILABLE');
    expect(websocket).toContain('iOS WebSocket tier gate check failed — fail-closed');
    expect(websocket).toContain("ws.close(1011, 'Access check unavailable')");
    expect(websocket).toContain('isAllowedWebSocketOrigin');
    expect(websocket).toContain('WebSocket upgrade rejected due to untrusted Origin');
    expect(websocket).toContain('consumeWebSocketMessageBudget');
    expect(websocket).toContain('RATE_LIMITED');
    expect(fs.existsSync(path.join(root, 'src/handlers/message.ts'))).toBe(false);
    expect(`${restGate}\n${websocket}`).not.toContain('tier gate check failed — falling through (fail-open)');
  });
});
