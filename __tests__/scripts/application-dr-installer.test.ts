import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const installer = path.resolve('scripts/application-dr-systemd-install.sh');
const layout = path.resolve('ops/application-dr/install-layout.tsv');
const backup = path.resolve('scripts/application-dr-backup.sh');
const service = path.resolve(
  'ops/application-dr/systemd/nexus-application-dr-backup.service',
);

describe('application DR root installer', () => {
  it('is syntactically valid and binds the exact declared install layout', () => {
    const syntax = spawnSync('bash', ['-n', installer], { encoding: 'utf8' });
    expect(syntax.status, syntax.stderr).toBe(0);

    const script = fs.readFileSync(installer, 'utf8');
    const declared = fs.readFileSync(layout, 'utf8').split('\n').slice(1).join('\n').trim();
    const match = script.match(/cat <<'LAYOUT'\n([\s\S]*?)\nLAYOUT/);
    expect(match?.[1]).toBe(declared);
    expect(script).toContain('validate_root_owned_chain "$SOURCE_ROOT"');
    expect(script).toContain('validate_root_owned_chain "$LAYOUT"');
    expect(script).toContain('validate_root_owned_chain "$source_path"');
    expect(script).toContain('path component is group/world writable');
    expect(script).toContain('install layout differs from the exact allowlist');
    expect(script).toContain('install target is outside the allowlist');
    expect(script).toContain('[ "$(realpath -m -- "$target")" = "$target" ]');
    expect(script).toContain('done <<< "$actual_layout"');
    expect(script).not.toContain('done < <(tail -n +2 "$LAYOUT")');
  });

  it('preflights the captured layout and serializes mutation with backup activity', () => {
    const script = fs.readFileSync(installer, 'utf8');
    const parsedLayout = script.indexOf('done <<< "$actual_layout"');
    const timerStop = script.indexOf('systemctl stop "$DR_TIMER"');
    const accountMutation = script.indexOf(
      'if [ "$drill_user_exists" = false ]; then',
      parsedLayout,
    );
    expect(parsedLayout).toBeGreaterThan(-1);
    expect(timerStop).toBeGreaterThan(parsedLayout);
    expect(accountMutation).toBeGreaterThan(timerStop);
    expect(script).toContain('exec 9>"$DR_BACKUP_LOCK"');
    expect(script).toContain('flock -n 9');
    expect(script).toContain('application DR backup service is active');
    expect(script).toContain('systemctl start "$DR_TIMER"');
    expect(script).toContain(
      '[ "$timer_enabled_after" = "$timer_enabled" ]',
    );
  });

  it('stages exact assets atomically and restores old targets when installation fails', () => {
    const script = fs.readFileSync(installer, 'utf8');
    expect(script).toContain(
      'mktemp -p "$target_parent" ".nexus-application-dr.stage.XXXXXX"',
    );
    expect(script).toContain(
      'mv -fT -- "${stage_paths[$index]}" "$target"',
    );
    expect(script).toContain(
      'for ((position=${#committed_indices[@]} - 1; position >= 0; position -= 1)); do',
    );
    expect(script).toContain('mv -fT -- "$backup" "$target"');
    expect(script).toContain('install_succeeded=false');
    expect(script).toContain('failed to restore $target from $backup');
    expect(script).toContain('failed to reload systemd after rollback');
    expect(script).toContain(
      'rollback incomplete; leaving $DR_TIMER stopped',
    );
    const rollbackFailure = script.indexOf(
      'if [ "$rollback_failed" = true ]; then',
    );
    const timerRestore = script.indexOf(
      'elif [ "$timer_active" = true ] && [ "$timer_restored" = false ]; then',
      rollbackFailure,
    );
    expect(timerRestore).toBeGreaterThan(rollbackFailure);
  });

  it('leaves a durable fail-closed journal across power loss and commits the guard first', () => {
    const script = fs.readFileSync(installer, 'utf8');
    const backupScript = fs.readFileSync(backup, 'utf8');
    const serviceUnit = fs.readFileSync(service, 'utf8');
    const journalWrite = script.indexOf('\nwrite_install_journal\n');
    const accountMutation = script.indexOf(
      'if [ "$drill_user_exists" = false ]; then',
      journalWrite,
    );
    const serviceCommit = script.indexOf('commit_asset "$service_index"');
    const remainingCommits = script.indexOf(
      'for ((index=0; index<planned; index+=1)); do',
      serviceCommit,
    );
    const stageInstall = script.indexOf(
      'install -o root -g root -m "${modes[$index]}" -- "${sources[$index]}" "$stage"',
    );
    const stageFsync = script.indexOf('fsync_path "$stage"', stageInstall);
    const targetReplace = script.indexOf(
      'mv -fT -- "${stage_paths[$index]}" "$target"',
    );
    const parentFsync = script.indexOf(
      'fsync_path "$target_parent"',
      targetReplace,
    );
    const journalRemove = script.lastIndexOf(
      'durable_remove "$DR_INSTALL_JOURNAL"',
    );

    expect(journalWrite).toBeGreaterThan(-1);
    expect(accountMutation).toBeGreaterThan(journalWrite);
    expect(serviceCommit).toBeGreaterThan(-1);
    expect(remainingCommits).toBeGreaterThan(serviceCommit);
    expect(stageFsync).toBeGreaterThan(stageInstall);
    expect(parentFsync).toBeGreaterThan(targetReplace);
    expect(journalRemove).toBeGreaterThan(targetReplace);
    expect(script).toContain('ln -- "$target" "$backup"');
    expect(script).toContain('fsync_path "$DR_STATE_DIR"');
    expect(serviceUnit).toContain(
      'ConditionPathExists=!/var/lib/nexus-application-dr/install-in-progress.v1',
    );
    expect(backupScript).toContain(
      'application DR installation is incomplete; rerun the root installer',
    );
  });

  it('creates only root-owned assets and a disabled isolated account without enabling backup', () => {
    const script = fs.readFileSync(installer, 'utf8');
    expect(script).toContain('--shell /usr/sbin/nologin');
    expect(script).toContain('drill account must not belong to supplementary groups');
    expect(script).toContain('/etc/nexus-application-dr');
    expect(script).toContain('/var/lib/nexus-application-dr');
    expect(script).toContain('"configurationWritten":false');
    expect(script).not.toMatch(/systemctl\s+enable/);
    expect(script).not.toContain('backup.env.example" "/etc/nexus-application-dr/backup.env');
  });

  it('rejects invocation without the exact root-owned source argument before mutation', () => {
    const result = spawnSync('bash', [installer], { encoding: 'utf8' });
    expect(result.status).toBe(64);
    expect(result.stderr).toContain(
      'Usage: sudo scripts/application-dr-systemd-install.sh <root-owned-source-root>',
    );
  });
});
