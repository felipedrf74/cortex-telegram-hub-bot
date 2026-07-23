import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(path, 'utf8');

describe('SonarScanner advisory launcher pin', () => {
  it('binds the reviewed macOS arm64 scanner to exact version and digests', () => {
    const lock = read('ops/sonarqube/scanner.lock.env');
    const verifier = read('scripts/quality-sonar-verify-scanner.sh');
    const scan = read('scripts/quality-sonar-scan.sh');

    expect(lock).toContain('SONAR_SCANNER_VERSION=8.1.0.6389');
    expect(lock).toContain('SONAR_SCANNER_PLATFORM=macosx-aarch64');
    expect(lock).toContain(
      'SONAR_SCANNER_ARCHIVE_URL=https://binaries.sonarsource.com/Distribution/sonar-scanner-cli/'
      + 'sonar-scanner-cli-8.1.0.6389-macosx-aarch64.zip',
    );
    expect(lock).toMatch(/SONAR_SCANNER_ARCHIVE_SHA256=[0-9a-f]{64}/);
    expect(lock).toMatch(/SONAR_SCANNER_LAUNCHER_SHA256=[0-9a-f]{64}/);
    expect(verifier).toContain('.nexus-archive-sha256');
    expect(verifier).toContain('Scanner launcher digest mismatch');
    expect(verifier).toContain('SonarScanner CLI $version');
    expect(verifier).toContain('Mac OS X .* aarch64$');
    expect(verifier).toContain('Scanner launcher must not be group- or world-writable');
    expect(scan).toContain('quality-sonar-verify-scanner.sh');
    expect(scan).toContain('--lock-file "$source_root/ops/sonarqube/scanner.lock.env"');
    expect(scan.indexOf('"$SCANNER_VERIFY"')).toBeLessThan(
      scan.indexOf('SONAR_TOKEN="$token" "$SCANNER_BIN"'),
    );
  });
});
