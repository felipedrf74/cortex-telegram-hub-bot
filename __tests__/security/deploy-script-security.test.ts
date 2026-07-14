import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('deploy script security contracts', () => {
  const deploySource = () => fs.readFileSync(path.resolve(__dirname, '../../scripts/deploy.sh'), 'utf8');
  const backupSource = () =>
    fs.readFileSync(path.resolve(__dirname, '../../scripts/remote-create-release-backup.sh'), 'utf8');
  const restoreSource = () => fs.readFileSync(path.resolve(__dirname, '../../scripts/restore.sh'), 'utf8');
  const deployStagingSource = () => fs.readFileSync(path.resolve(__dirname, '../../scripts/deploy-staging.sh'), 'utf8');
  const stagingSmokeSource = () => fs.readFileSync(path.resolve(__dirname, '../../scripts/staging-smoke.sh'), 'utf8');
  const readinessSource = () => fs.readFileSync(path.resolve(__dirname, '../../scripts/deploy-readiness-check.sh'), 'utf8');

  it('creates production backup archives with owner-only permissions', () => {
    const deploy = deploySource();
    expect(deploy).toContain('umask 077');
    expect(deploy).toContain('remote-create-release-backup.sh');

    const backup = backupSource();
    expect(backup).toContain('umask 077');
    expect(backup).toContain('install -d -m 700 "$BACKUP_DIR"');
    expect(backup).toContain('chmod 600 "$TMP_ARCHIVE"');
    expect(backup).toContain('mv -f "$TMP_ARCHIVE" "$ARCHIVE"');
    expect(backup).toContain("db.pragma('integrity_check')");
    expect(backup).toContain("db.pragma('foreign_key_check')");

    const restore = restoreSource();
    expect(restore).toContain('umask 077');
    expect(restore).toContain('install -d -m 700 "$BACKUP_DIR"');
    expect(restore).toContain('chmod 600 "$TMP_PRE_RESTORE_SNAPSHOT"');
  });

  it('does not pass portal or Notion bearer secrets in command arguments', () => {
    const deploy = deploySource();
    expect(deploy).not.toContain("-H 'x-portal-session: ${PROD_SESSION");
    expect(deploy).not.toContain("-H 'Authorization: Bearer $PORTAL_TOKEN'");
    expect(deploy).not.toContain('-H "Authorization: Bearer $NOTION_TOKEN"');
    expect(deploy).toContain('printf \'x-portal-session: %s\\n\' "$PROD_SESSION" > "$HEADER_FILE"');
    expect(deploy).toContain('printf \'Authorization: Bearer %s\\n\' "$PORTAL_TOKEN" > "$HEADER_FILE"');
    expect(deploy).toContain('printf \'Authorization: Bearer %s\\n\' "$NOTION_TOKEN"');
    expect(deploy).toContain('-H @"$HEADER_FILE"');
    expect(deploy).toContain('-H @"$NOTION_HEADERS"');
  });

  it('keeps staging portal and readiness secrets out of curl argv', () => {
    const deployStaging = deployStagingSource();
    const stagingSmoke = stagingSmokeSource();
    const readiness = readinessSource();
    const checkedScripts = [deployStaging, stagingSmoke, readiness];

    for (const source of checkedScripts) {
      expect(source).not.toContain("-H 'Authorization: Bearer");
      expect(source).not.toContain('-H "Authorization: Bearer');
      expect(source).not.toContain("-H 'x-portal-session:");
      expect(source).not.toContain('-H "x-portal-session:');
      expect(source).not.toContain("-H 'x-internal-secret:");
      expect(source).not.toContain('-H "x-internal-secret:');
    }

    expect(deployStaging).toContain('printf \'x-portal-session: %s\\n\' "$STAGING_SESSION" > "$HEADER_FILE"');
    expect(deployStaging).toContain('printf \'Authorization: Bearer %s\\n\' "$STAGING_TOKEN" > "$HEADER_FILE"');
    expect(deployStaging).toContain('[ -n "$STAGING_SESSION" ] || exit 1');
    expect(deployStaging).toContain('[ -n "$STAGING_TOKEN" ] || exit 1');
    expect(deployStaging).toContain('chmod 600 "$HEADER_FILE"');
    expect(deployStaging).toContain('-H @"$HEADER_FILE"');

    expect(stagingSmoke).toContain('printf \'x-portal-session: %s\\n\' "$STAGING_SESSION" > "$HEADER_FILE"');
    expect(stagingSmoke).toContain('printf \'Authorization: Bearer %s\\n\' "$STAGING_TOKEN" > "$HEADER_FILE"');
    expect(stagingSmoke).toContain('[ -n "$STAGING_SESSION" ] || exit 1');
    expect(stagingSmoke).toContain('[ -n "$STAGING_TOKEN" ] || exit 1');
    expect(stagingSmoke).toContain('chmod 600 "$HEADER_FILE"');
    expect(stagingSmoke).toContain('-H @"$HEADER_FILE"');

    expect(readiness).toContain('printf \'x-internal-secret: %s\\n\' "$CONTENT_SECRET" > "$CONTENT_HEADER_FILE"');
    expect(readiness).toContain('chmod 600 "$CONTENT_HEADER_FILE"');
    expect(readiness).toContain('-H @"$CONTENT_HEADER_FILE"');
  });
});
