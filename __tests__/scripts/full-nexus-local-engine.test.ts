// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { CURRENT_LEGAL_DOCUMENTS } from '../../src/services/legal-consent';

describe('full nexus local engine smoke helper', () => {
  const currentLiteralPayload = `"termsVersion":"${CURRENT_LEGAL_DOCUMENTS.terms.version}","privacyVersion":"${CURRENT_LEGAL_DOCUMENTS.privacy.version}"`;

  it('scripts/full-nexus-local-engine.sh writes acceptedLegal from canonical legal versions', () => {
    const script = readScript('scripts/full-nexus-local-engine.sh');

    expect(script).toMatch(/current_legal_versions\(\)[\s\S]*CURRENT_LEGAL_DOCUMENTS\.terms\.version[\s\S]*CURRENT_LEGAL_DOCUMENTS\.privacy\.version/);
    expect(script).toMatch(/"acceptedLegal":\{"accepted":true,"termsVersion":"\$\{LEGAL_TERMS_VERSION\}","privacyVersion":"\$\{LEGAL_PRIVACY_VERSION\}"\}/);
    expect(script).not.toContain(currentLiteralPayload);
  });

  it('scripts/chat-tenant-security-smoke.js registers users with acceptedLegal from canonical legal versions', () => {
    const script = readScript('scripts/chat-tenant-security-smoke.js');

    expect(script).toMatch(/function currentLegalDocuments\(\)[\s\S]*loadDist\('services\/legal-consent\.js'\)[\s\S]*CURRENT_LEGAL_DOCUMENTS/);
    expect(script).toMatch(/acceptedLegal:\s*\{[\s\S]*accepted:\s*true,[\s\S]*termsVersion:\s*legalDocuments\.terms\.version,[\s\S]*privacyVersion:\s*legalDocuments\.privacy\.version,[\s\S]*\}/);
    expect(script).not.toContain(currentLiteralPayload);
  });

  it.each([
    'scripts/chatv2-observe-legacy-parity.ts',
    'scripts/chatv2-runtime-evidence-smoke.ts',
  ])('%s registers local iOS users with acceptedLegal from canonical legal versions', (scriptPath) => {
    const script = readScript(scriptPath);

    expect(script).toMatch(/acceptedLegal:\s*\{[\s\S]*accepted:\s*true,[\s\S]*termsVersion:\s*CURRENT_LEGAL_DOCUMENTS\.terms\.version,[\s\S]*privacyVersion:\s*CURRENT_LEGAL_DOCUMENTS\.privacy\.version,[\s\S]*\}/);
    expect(script).not.toContain(currentLiteralPayload);
  });
});

function readScript(scriptPath: string): string {
  return readFileSync(join(process.cwd(), scriptPath), 'utf8');
}
