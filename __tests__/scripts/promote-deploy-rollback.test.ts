import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..');
const DEPLOY_SH = join(ROOT, 'scripts', 'deploy.sh');
const DEPLOY_STAGING_SH = join(ROOT, 'scripts', 'deploy-staging.sh');
const PROMOTE_SH = join(ROOT, 'scripts', 'promote-to-prod.sh');
const ROLLBACK_SH = join(ROOT, 'scripts', 'rollback.sh');
const PM2_SANITIZED_START_SH = join(ROOT, 'scripts', 'remote-start-sanitized-pm2.sh');

describe('deploy/promote rollback mutation marker', () => {
  it('deploy.sh only leaves the mutation marker when production was touched', () => {
    const deploy = readFileSync(DEPLOY_SH, 'utf8');

    expect(deploy).toMatch(/DEPLOY_MUTATION_MARKER=/);
    expect(deploy).toMatch(/rm -f "\$DEPLOY_MUTATION_MARKER"/);

    const markerWrite = deploy.indexOf('> "$DEPLOY_MUTATION_MARKER"');
    const stopServices = deploy.indexOf('Stopping services on server');
    const validation = deploy.indexOf('VALIDATE FIRST');
    expect(markerWrite).toBeGreaterThan(validation);
    expect(markerWrite).toBeGreaterThan(stopServices);

    const healthFailureExit = deploy.indexOf('if [ "$HEALTH_OK" != true ]; then');
    const finalMarkerCleanup = deploy.lastIndexOf('rm -f "$DEPLOY_MUTATION_MARKER"');
    expect(finalMarkerCleanup).toBeGreaterThan(healthFailureExit);
  });

  it('deploy.sh exits dry-run before build, git restore, marker cleanup, or remote mutation', () => {
    const deploy = readFileSync(DEPLOY_SH, 'utf8');

    const dryRunExit = deploy.indexOf('# Dry-run early-exit');
    const build = deploy.indexOf('# ── 1. Build TypeScript locally');
    const markerCleanup = deploy.indexOf('rm -f "$DEPLOY_MUTATION_MARKER"');
    const restoreCall = deploy.indexOf('restore_deploy_generated_artifacts');

    expect(dryRunExit).toBeGreaterThan(0);
    expect(build).toBeGreaterThan(dryRunExit);
    expect(deploy.slice(0, dryRunExit)).toContain('if [ "$DRY_RUN" != "1" ]; then\n  rm -f "$DEPLOY_MUTATION_MARKER"');
    expect(markerCleanup).toBeLessThan(dryRunExit);
    expect(deploy.slice(0, dryRunExit)).toContain('if [ "$DRY_RUN" != "1" ]; then\n  restore_deploy_generated_artifacts');
    expect(restoreCall).toBeLessThan(dryRunExit);
  });

  it('deploy.sh keeps remote install and portal health failures fail-closed', () => {
    const deploy = readFileSync(DEPLOY_SH, 'utf8');

    expect(deploy).toContain('set -euo pipefail; cd $REMOTE_DIR && npm ci --production 2>&1 | tail -1');
    expect(deploy).toContain('set -euo pipefail; cd $REMOTE_DIR/content-engine && source .venv/bin/activate && pip install -q -r requirements.txt 2>&1 | tail -3');
    expect(deploy).toContain('printf \'x-portal-session: %s\\n\' "$PROD_SESSION" > "$HEADER_FILE"');
    expect(deploy).toContain('printf \'Authorization: Bearer %s\\n\' "$PORTAL_TOKEN" > "$HEADER_FILE"');
    expect(deploy).toContain('curl -sf -o /dev/null -H @"$HEADER_FILE"');
    expect(deploy).not.toContain("curl -sf -o /dev/null -H 'x-portal-session:");
    expect(deploy).not.toContain("curl -sf -o /dev/null -H 'Authorization: Bearer $PORTAL_TOKEN'");
    expect(deploy).toContain('curl -sf -o /dev/null http://localhost:8200/api/snapshot');
  });

  it('deploy.sh requires a verified backup and records its exact archive before rsync', () => {
    const deploy = readFileSync(DEPLOY_SH, 'utf8');

    const backup = deploy.indexOf('remote-create-release-backup.sh');
    const exactArchive = deploy.indexOf("printf 'BACKUP_FILE=%s\\n' \"$BACKUP_FILE\"");
    const rsync = deploy.indexOf('# ── 4. Sync files');
    expect(backup).toBeGreaterThan(0);
    expect(exactArchive).toBeGreaterThan(backup);
    expect(rsync).toBeGreaterThan(exactArchive);
    expect(deploy).toContain('Backup failed; refusing to replace production files');
    expect(deploy).not.toContain('Backup skipped');
  });

  it('deploy.sh fails closed unless both production PM2 processes are proved stopped', () => {
    const deploy = readFileSync(DEPLOY_SH, 'utf8');
    const stopBlockStart = deploy.indexOf("<<'REMOTE_STOP_PRODUCTION'");
    const stopBodyStart = deploy.indexOf('\n', stopBlockStart) + 1;
    const stopBlockEnd = deploy.indexOf('\nREMOTE_STOP_PRODUCTION', stopBodyStart);
    const stopBlock = deploy.slice(stopBodyStart, stopBlockEnd);

    expect(stopBlockStart).toBeGreaterThan(0);
    expect(stopBlock).toContain('set -euo pipefail');
    expect(stopBlock).toContain('"$PM2_BIN" stop "$app_name"');
    expect(stopBlock).toContain('"$PM2_BIN" jlist');
    expect(stopBlock).toContain('PM2 process did not stop');
    expect(stopBlock).not.toContain('2>/dev/null');
  });

  it('deploy preflight requires the portal credential selected by its auth mode', () => {
    const production = readFileSync(DEPLOY_SH, 'utf8');
    const staging = readFileSync(DEPLOY_STAGING_SH, 'utf8');

    for (const deploy of [production, staging]) {
      expect(deploy).toContain('PORTAL_REQUIRE_SESSION_AUTH_VALUE=');
      expect(deploy).toContain("grep -qE '^PORTAL_SESSION_SECRET=.+");
      expect(deploy).toContain("grep -qE '^PORTAL_TOKEN=.+");
    }
    expect(production).not.toContain('CONTENT_ENGINE_PORT PORTAL_TOKEN OAUTH_ENCRYPTION_KEY');
    expect(staging).not.toContain('CONTENT_ENGINE_PORT PORTAL_TOKEN OAUTH_ENCRYPTION_KEY');
  });

  it('production and staging recreate PM2 processes through the sanitized bootstrap', () => {
    const production = readFileSync(DEPLOY_SH, 'utf8');
    const staging = readFileSync(DEPLOY_STAGING_SH, 'utf8');
    const bootstrap = readFileSync(PM2_SANITIZED_START_SH, 'utf8');

    expect(production).toContain('< "$LOCAL_DIR/scripts/remote-start-sanitized-pm2.sh"');
    expect(production).toContain('"nexus-hub,content-engine"');
    expect(staging).toContain('< "$LOCAL_DIR/scripts/remote-start-sanitized-pm2.sh"');
    expect(staging).toContain('"nexus-hub-staging,content-engine-staging"');
    expect(production).toContain('node -r dotenv/config dist/tools/portal-session-token.js');
    expect(staging).toContain('node -r dotenv/config dist/tools/portal-session-token.js');
    expect(production).not.toContain('. ./.env');
    expect(staging).not.toContain('. ./.env');
    expect(bootstrap).toContain('env -i');
    expect(bootstrap).toContain('delete "${APP_NAMES[@]}"');
    expect(bootstrap).toContain('save --force');
    expect(bootstrap).toContain('PM2 resurrection dump retained prohibited key');
    expect(bootstrap).not.toContain('. ./.env');
    expect(bootstrap).not.toContain('source .env');
  });

  it('rollback recreates both production processes without starting historical PM2 entries by name', () => {
    const rollback = readFileSync(ROLLBACK_SH, 'utf8');

    expect(rollback).toContain('ROLLBACK_RUNTIME_CONFIG="ecosystem.config.js"');
    expect(rollback).toContain('< "$LOCAL_DIR/scripts/remote-start-sanitized-pm2.sh"');
    expect(rollback).toContain('"rollback-unknown"');
    expect(rollback).toContain('"nexus-hub,content-engine"');
    expect(rollback).toContain('PM2 cwd does not match active runtime');
    expect(rollback).toContain('rm -f "$base_dir/current" "$base_dir/current.next"');
    expect(rollback).toContain('http://127.0.0.1:8200/health');
    expect(rollback).toContain('http://127.0.0.1:8100/health');
    expect(rollback).toContain('restored package version mismatch');
    expect(rollback).toContain('"$pm2_bin" save --force');
    expect(rollback).not.toContain('$PM2 start content-engine');
    expect(rollback).not.toContain('$PM2 start nexus-hub');
    expect(rollback).not.toContain('$PM2 save;');
  });

  it('deploy.sh only skips full local verify after signed evidence, clean RC history, and rollback drill gates', () => {
    const deploy = readFileSync(DEPLOY_SH, 'utf8');

    expect(deploy).toContain('check_clean_rc_history()');
    expect(deploy).toContain('RELEASE_EVIDENCE_PATH="${NEXUS_RELEASE_EVIDENCE_PATH:-$LOCAL_DIR/.local/release/evidence/latest-release-evidence.json}"');
    expect(deploy).toContain('REUSED_RELEASE_EVIDENCE=0');
    expect(deploy).toContain('NEXUS_RELEASE_MIN_CLEAN_RCS:-3');
    expect(deploy).toContain('NEXUS_RELEASE_CLEAN_RC_EVIDENCE_DIR:-$LOCAL_DIR/.local/release/evidence');
    expect(deploy).toContain('release-evidence-"$expected_sha"-*.json');
    expect(deploy).toContain('release_evidence_run_key()');
    expect(deploy).toContain('Duplicate signed RC run ID ignored');
    expect(deploy).toContain('--evidence "$RELEASE_EVIDENCE_PATH"');
    expect(deploy).toContain('check_current_rollback_drill()');
    expect(deploy).not.toContain('check_staging_manifest_parity()');
    expect(deploy).toContain('if check_clean_rc_history && check_current_rollback_drill; then');
    expect(deploy).toContain('run_typecheck_only');
    expect(deploy).toContain('REUSED_RELEASE_EVIDENCE=1');
    expect(deploy).toContain('release_evidence_manifest_digest /tmp/nexus-release-evidence-validate.json');
    expect(deploy).toContain('Evidence reuse preconditions are not complete — full verify');
    expect(deploy).toContain('run_full_verify');
    expect(deploy).toContain('if [ "$REUSED_RELEASE_EVIDENCE" = "1" ]; then');
  });

  it('promote-to-prod.sh skips auto rollback for pre-mutation deploy failures', () => {
    const promote = readFileSync(PROMOTE_SH, 'utf8');

    expect(promote).toMatch(/DEPLOY_MUTATION_MARKER=/);
    expect(promote).toContain('NEXUS_DEPLOY_MUTATION_MARKER="$DEPLOY_MUTATION_MARKER" \\');
    expect(promote).not.toContain('NEXUS_STAGING_PROD_MANIFEST_PARITY_OK=1');
    expect(promote).not.toContain('NEXUS_STAGING_MANIFEST_DIGEST="$STAGING_MANIFEST_DIGEST"');
    expect(promote).toContain('"$LOCAL_DIR/scripts/deploy.sh"');
    expect(promote).toMatch(/\[ -f "\$DEPLOY_MUTATION_MARKER" \]/);
    expect(promote).toMatch(/Deploy failed before production mutation\. Auto rollback skipped\./);
    expect(promote).toContain("sed -n 's/^BACKUP_FILE=//p'");
    expect(promote).toContain('rollback.sh" --backup-file "$EXACT_BACKUP"');
    expect(promote).not.toContain('rollback.sh" latest');
    expect(promote).toContain('Refusing to restore an arbitrary stale backup');
  });

  it('rollback accepts only an exact deploy archive under the production backup directory', () => {
    const rollback = readFileSync(ROLLBACK_SH, 'utf8');

    expect(rollback).toContain('--backup-file)');
    expect(rollback).toContain('"$BACKUP_DIR"/v*.tar.gz');
    expect(rollback).toContain('if [ "$backup" = "$BACKUP_FILE_OVERRIDE" ]; then');
    expect(rollback).toContain('Exact backup is not present on the server');
  });
});
