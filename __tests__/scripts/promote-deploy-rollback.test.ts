import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..');
const DEPLOY_SH = join(ROOT, 'scripts', 'deploy.sh');
const PROMOTE_SH = join(ROOT, 'scripts', 'promote-to-prod.sh');

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
    expect(deploy).toContain("curl -sf -o /dev/null -H 'x-portal-session:");
    expect(deploy).toContain("curl -sf -o /dev/null -H 'Authorization: Bearer $PORTAL_TOKEN'");
    expect(deploy).toContain('curl -sf -o /dev/null http://localhost:8200/api/snapshot');
  });

  it('deploy.sh only skips full local verify after signed evidence, clean RC history, and rollback drill gates', () => {
    const deploy = readFileSync(DEPLOY_SH, 'utf8');

    expect(deploy).toContain('check_clean_rc_history()');
    expect(deploy).toContain('RELEASE_EVIDENCE_PATH="${NEXUS_RELEASE_EVIDENCE_PATH:-$LOCAL_DIR/.local/release/evidence/latest-release-evidence.json}"');
    expect(deploy).toContain('REUSED_RELEASE_EVIDENCE=0');
    expect(deploy).toContain('NEXUS_RELEASE_MIN_CLEAN_RCS:-3');
    expect(deploy).toContain('NEXUS_RELEASE_CLEAN_RC_EVIDENCE_DIR:-$LOCAL_DIR/.local/release/evidence');
    expect(deploy).toContain('release-evidence-"$expected_sha"-*.json');
    expect(deploy).toContain('--evidence "$RELEASE_EVIDENCE_PATH"');
    expect(deploy).toContain('check_current_rollback_drill()');
    expect(deploy).toContain('check_staging_manifest_parity()');
    expect(deploy).toContain('if check_clean_rc_history && check_current_rollback_drill && check_staging_manifest_parity; then');
    expect(deploy).toContain('run_typecheck_only');
    expect(deploy).toContain('REUSED_RELEASE_EVIDENCE=1');
    expect(deploy).toContain('POST_BUILD_MANIFEST_DIGEST" != "${NEXUS_STAGING_MANIFEST_DIGEST:-}"');
    expect(deploy).toContain('Evidence reuse preconditions are not complete — full verify');
    expect(deploy).toContain('run_full_verify');
    expect(deploy).toContain('if [ "$REUSED_RELEASE_EVIDENCE" = "1" ]; then');
  });

  it('promote-to-prod.sh skips auto rollback for pre-mutation deploy failures', () => {
    const promote = readFileSync(PROMOTE_SH, 'utf8');

    expect(promote).toMatch(/DEPLOY_MUTATION_MARKER=/);
    expect(promote).toContain('NEXUS_DEPLOY_MUTATION_MARKER="$DEPLOY_MUTATION_MARKER" \\');
    expect(promote).toContain('NEXUS_STAGING_PROD_MANIFEST_PARITY_OK=1 \\');
    expect(promote).toContain('NEXUS_STAGING_MANIFEST_DIGEST="$STAGING_MANIFEST_DIGEST" \\');
    expect(promote).toContain('"$LOCAL_DIR/scripts/deploy.sh"');
    expect(promote).toMatch(/\[ -f "\$DEPLOY_MUTATION_MARKER" \]/);
    expect(promote).toMatch(/Deploy failed before production mutation\. Auto rollback skipped\./);
  });
});
