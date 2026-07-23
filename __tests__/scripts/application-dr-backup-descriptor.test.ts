import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const backupScript = path.resolve('scripts/application-dr-backup.sh');

describe('application DR recovery descriptor boundary', () => {
  it('publishes the exact all-or-none descriptor interface', () => {
    const help = spawnSync('bash', [backupScript, '--help'], {
      encoding: 'utf8',
    });
    expect(help.status, help.stderr).toBe(0);
    expect(help.stdout).toContain(
      '--require-recovery-runtime <release-dir> '
      + '--recovery-descriptor <root-mode-0600-file>',
    );

    const source = fs.readFileSync(backupScript, 'utf8');
    expect(source).toContain(
      '--recovery-descriptor) RECOVERY_DESCRIPTOR='
      + '"${2:?--recovery-descriptor requires a path}"',
    );
    expect(source).toContain(
      'for value in "$REQUIRED_RECOVERY_RUNTIME" "$RECOVERY_DESCRIPTOR" '
      + '"$RECOVERY_ESCROW_ID"',
    );
    expect(source).toContain('"$RECOVERY_ESCROW_PHASE"');
    expect(source).toContain('\n  10)\n');
    expect(source).toContain('pre-mutation|post-soak');
    expect(source).toContain(
      'private_root_file "$RECOVERY_DESCRIPTOR" "recovery runtime descriptor"',
    );
  });

  it('packs only the supplied root-owned descriptor and retains identity inspection', () => {
    const source = fs.readFileSync(backupScript, 'utf8');
    const recoveryBlock = source.slice(
      source.indexOf('if [ -n "$REQUIRED_RECOVERY_RUNTIME" ]; then'),
      source.indexOf('\nprune_release_age \\\n'),
    );
    expect(recoveryBlock).toContain(
      '"$NEXUS_DR_PYTHON_BIN" "$RECOVERY_ARCHIVE_HELPER" pack',
    );
    expect(recoveryBlock).toContain('--descriptor "$RECOVERY_DESCRIPTOR"');
    expect(recoveryBlock).toContain(
      '"$NEXUS_DR_PYTHON_BIN" "$RECOVERY_ARCHIVE_HELPER" inspect',
    );
    expect(recoveryBlock).toContain(
      'identity.get("recoveryRuntimeDigest") != recovery',
    );
    expect(recoveryBlock).not.toContain(' prepare ');
    expect(recoveryBlock).not.toContain('current-recovery-descriptor.json');
  });

  it('does not execute the runtime verifier or any configured Node binary', () => {
    const source = fs.readFileSync(backupScript, 'utf8');
    expect(source).not.toContain('NEXUS_DR_NODE_BIN');
    expect(source).not.toContain('NEXUS_DR_RELEASE_PUBLIC_KEY');
    expect(source).not.toContain('RECOVERY_RUNTIME_HELPER');
    expect(source).not.toContain('RECOVERY_IDENTITY_HELPER');
    expect(source).not.toContain('application-dr-recovery-runtime.mjs');
    expect(source).not.toContain('release-recovery-runtime-identity.mjs');
  });

  it('remains valid Bash', () => {
    const syntax = spawnSync('bash', ['-n', backupScript], {
      encoding: 'utf8',
    });
    expect(syntax.status, syntax.stderr).toBe(0);
  });
});
