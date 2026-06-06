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

  it('promote-to-prod.sh skips auto rollback for pre-mutation deploy failures', () => {
    const promote = readFileSync(PROMOTE_SH, 'utf8');

    expect(promote).toMatch(/DEPLOY_MUTATION_MARKER=/);
    expect(promote).toMatch(/NEXUS_DEPLOY_MUTATION_MARKER="\$DEPLOY_MUTATION_MARKER" "\$LOCAL_DIR\/scripts\/deploy\.sh"/);
    expect(promote).toMatch(/\[ -f "\$DEPLOY_MUTATION_MARKER" \]/);
    expect(promote).toMatch(/Deploy failed before production mutation\. Auto rollback skipped\./);
  });
});
