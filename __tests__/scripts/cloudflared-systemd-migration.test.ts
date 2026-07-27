import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = 'scripts/cloudflared-systemd-migrate.sh';
const CRON_INSPECTOR = 'scripts/cloudflared-cron-source-inspector.py';
const UNIT = 'ops/cloudflared/systemd/nexus-cloudflared.service';
const TEMPLATE = 'ops/cloudflared/config.yml.example';
const UUID = '11111111-2222-3333-4444-555555555555';
const SECRET_SENTINEL = 'credential-material-must-never-appear';

function digest(path: string) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function runVerify(
  binary: string,
  config: string,
  credential: string,
  credentialDigest = digest(credential),
) {
  return spawnSync('bash', [
    SCRIPT,
    '--verify-inputs-only',
    '--binary', binary,
    '--binary-sha256', digest(binary),
    '--config', config,
    '--config-sha256', digest(config),
    '--credential', credential,
    '--credential-sha256', credentialDigest,
  ], { cwd: process.cwd(), encoding: 'utf8', timeout: 10_000 });
}

function runCronInspector(
  root: string,
  singleFiles: string[],
  commandDirectories: string[],
) {
  const uid = process.getuid?.() ?? 0;
  const inspector = JSON.stringify(realpathSync(CRON_INSPECTOR));
  const source = `
import importlib.util
spec = importlib.util.spec_from_file_location("cloudflared_cron_inspector", ${inspector})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.inspect_sources(
    ${JSON.stringify(singleFiles)},
    ${JSON.stringify(commandDirectories)},
    trusted_uid=${uid},
    trust_root=${JSON.stringify(root)},
)
`;
  return spawnSync('python3', ['-c', source], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 10_000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
}

describe('root-owned cloudflared systemd migration', () => {
  it('validates exact credential/config identity and canonical routes without emitting credential material', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'nexus-cloudflared-')));
    try {
      const binary = join(root, 'cloudflared');
      const config = join(root, 'config.yml');
      const credential = join(root, 'tunnel.json');
      writeFileSync(binary, `#!/bin/sh
case "$*" in
  *"--version"*) exit 0 ;;
  *"ingress validate"*) exit 0 ;;
  *"ingress rule https://api.nexushub.me/health"*)
    printf '%s\\n' 'hostname: api.nexushub.me' 'service: http://127.0.0.1:8200' ;;
  *) exit 64 ;;
esac
`, { mode: 0o700 });
      writeFileSync(config, `tunnel: ${UUID}
credentials-file: /run/credentials/nexus-cloudflared.service/tunnel.json
ingress:
  - hostname: api.nexushub.me
    service: http://127.0.0.1:8200
  - service: http_status:404
`, { mode: 0o600 });
      writeFileSync(credential, `${JSON.stringify({
        AccountTag: 'account',
        TunnelID: UUID,
        TunnelSecret: SECRET_SENTINEL,
      })}\n`, { mode: 0o600 });
      chmodSync(binary, 0o700);
      chmodSync(config, 0o600);
      chmodSync(credential, 0o600);

      const valid = runVerify(binary, config, credential);
      expect(valid.status, valid.stderr).toBe(0);
      expect(JSON.parse(valid.stdout)).toEqual({
        ok: true,
        mode: 'verify-inputs-only',
        tokenMaterialEmitted: false,
      });
      expect(`${valid.stdout}${valid.stderr}`).not.toContain(SECRET_SENTINEL);

      const canonicalConfig = readFileSync(config, 'utf8');
      writeFileSync(
        config,
        canonicalConfig.replace(
          '  - service: http_status:404',
          '  - hostname: api-staging.nexushub.me\n'
            + '    service: http://127.0.0.1:8201\n'
            + '  - service: http_status:404',
        ),
      );
      chmodSync(config, 0o600);
      const unresolvedRoute = runVerify(binary, config, credential);
      expect(unresolvedRoute.status).not.toBe(0);
      writeFileSync(config, canonicalConfig);
      chmodSync(config, 0o600);

      const wrongDigest = runVerify(binary, config, credential, '0'.repeat(64));
      expect(wrongDigest.status).not.toBe(0);
      expect(`${wrongDigest.stdout}${wrongDigest.stderr}`).not.toContain(SECRET_SENTINEL);

      writeFileSync(config, readFileSync(config, 'utf8').replace(UUID, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'));
      chmodSync(config, 0o600);
      const mismatch = runVerify(binary, config, credential);
      expect(mismatch.status).not.toBe(0);
      expect(`${mismatch.stdout}${mismatch.stderr}`).not.toContain(SECRET_SENTINEL);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('restarts and attests the exact boot-persistent replica before pidfd retirement', () => {
    const script = readFileSync(SCRIPT, 'utf8');
    const unit = readFileSync(UNIT, 'utf8');
    const template = readFileSync(TEMPLATE, 'utf8');

    expect(unit).toContain('DynamicUser=yes');
    expect(unit).toContain('LoadCredential=config.yml:/etc/nexus-cloudflared/config.yml');
    expect(unit).toContain('LoadCredential=tunnel.json:/etc/nexus-cloudflared/tunnel.json');
    expect(unit).toContain('--no-autoupdate');
    expect(unit).toContain('--metrics 127.0.0.1:20243');
    expect(unit).toContain('Restart=on-failure');
    expect(unit).not.toMatch(/token/i);
    expect(template).toContain('credentials-file: /run/credentials/nexus-cloudflared.service/tunnel.json');
    expect(template).toContain('hostname: api.nexushub.me');
    expect(template).not.toContain('portal.nexushub.me');
    expect(template).not.toContain('api-staging.nexushub.me');
    expect(template).not.toMatch(/TunnelSecret|eyJ[a-zA-Z0-9_-]+/);

    const restart = script.indexOf('systemctl restart "$SERVICE"');
    const connected = script.indexOf('verify_new_connector', restart);
    const enabled = script.indexOf('systemctl enable "$SERVICE"', connected);
    const retirement = script.indexOf('state_fields="$(read_state)"', enabled);
    const stopped = script.indexOf(
      'legacy_broker_command STOP OK:STOP 10',
      retirement,
    );
    const postStopProof = script.indexOf('verify_new_connector', stopped);
    const terminated = script.indexOf(
      'legacy_broker_command TERM OK:TERM 35',
      postStopProof,
    );
    expect(restart).toBeGreaterThan(0);
    expect(connected).toBeGreaterThan(restart);
    expect(enabled).toBeGreaterThan(connected);
    expect(stopped).toBeGreaterThan(enabled);
    expect(postStopProof).toBeGreaterThan(stopped);
    expect(terminated).toBeGreaterThan(postStopProof);
    expect(script).not.toContain('systemctl start "$SERVICE"');
    expect(script).toContain(
      '[ "$(file_digest "/proc/$pid/exe")" = "$binary_digest" ]',
    );
    expect(script).toContain(
      'fragment="$(systemctl show "$SERVICE" -p FragmentPath --value)"',
    );
    expect(script).toContain(
      'dropins="$(systemctl show "$SERVICE" -p DropInPaths --value)"',
    );
    expect(script).toContain('"unitSha256": unit_digest');
    expect(script).toContain(
      '[ "$(file_digest "$UNIT_TARGET")" = "$unit_digest" ]',
    );
    expect(script).toContain('os.pidfd_open(pid, 0)');
    expect(script).toContain(
      'signal.pidfd_send_signal(pidfd, signal.SIGSTOP, None, 0)',
    );
    expect(script).toContain(
      'signal.pidfd_send_signal(pidfd, signal.SIGTERM, None, 0)',
    );
    expect(script).not.toContain('kill -STOP "$legacy_pid"');
    expect(script).not.toContain('kill -TERM "$legacy_pid"');
    expect(script).toContain('legacy cron launch is still present');
    expect(script).toContain('cloudflared_tunnel_ha_connections');
    expect(script).toContain('"credentialSha256": credential_digest');
    expect(script).toContain(
      '[ "$(file_digest "$CREDENTIAL_TARGET")" = "$credential_digest" ]',
    );
    expect(script).not.toMatch(/(?:--token|TUNNEL_TOKEN=)[^\n]*/);
  });

  it('resumes and exits on handoff signals and fails closed on incomplete cron inspection', () => {
    const script = readFileSync(SCRIPT, 'utf8');
    const inspector = readFileSync(CRON_INSPECTOR, 'utf8');

    expect(script).toContain("trap 'abort_legacy_handoff 129' HUP");
    expect(script).toContain("trap 'abort_legacy_handoff 130' INT");
    expect(script).toContain("trap 'abort_legacy_handoff 143' TERM");
    expect(script).toContain('legacy_broker_command CONT_EXIT OK:CONT_EXIT 10');
    expect(script).toContain('cleanup_legacy_broker\n  trap - EXIT\n  exit "$status"');

    expect(script).toContain('assert_no_cloudflared_cron_sources || cron_status="$?"');
    expect(script).toContain('10) die "legacy cron launch is still present;');
    expect(script).toContain('*) die "cron launch sources could not be inspected completely"');
    for (const source of [
      '/etc/crontab',
      '/etc/anacrontab',
      '/etc/cron.d',
      '/etc/cron.hourly',
      '/etc/cron.daily',
      '/etc/cron.weekly',
      '/etc/cron.monthly',
      '/var/spool/cron/crontabs',
    ]) {
      expect(inspector).toContain(`"${source}"`);
    }
    expect(inspector).toContain('INSPECTION_ERROR = 20');
    expect(script).toContain(
      'validate_file "$inspector" helper root || return 20',
    );
    expect(inspector).toContain('target = os.readlink(path, dir_fd=directory_fd)');
    expect(inspector).not.toContain('os.path.realpath(path');
    expect(inspector).toContain('os.O_NOFOLLOW');
    expect(inspector).toContain('with os.scandir(descriptor) as entries');
    expect(inspector).toContain('current_identity = os.stat(');
    expect(inspector).toContain('getattr(before, field) != getattr(after, field)');
    expect(script).not.toContain('crontab -u "$legacy_user" -l');
  });

  it('inspects stable root-controlled cron symlinks and rejects unsafe targets', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'nexus-cloudflared-cron-')));
    try {
      const cronDirectory = join(root, 'cron.daily');
      const packageDirectory = join(root, 'package');
      const target = join(packageDirectory, 'package-cron');
      const link = join(cronDirectory, 'package-cron');
      mkdirSync(cronDirectory, { mode: 0o700 });
      mkdirSync(packageDirectory, { mode: 0o700 });
      writeFileSync(target, '#!/bin/sh\nexit 0\n', { mode: 0o644 });
      symlinkSync(target, link);

      const valid = runCronInspector(root, [], [cronDirectory]);
      expect(valid.status, valid.stderr).toBe(0);
      expect(`${valid.stdout}${valid.stderr}`).toBe('');

      const secretCron = 'exec cloudflared tunnel run secret-cron-material';
      writeFileSync(target, `#!/bin/sh\n${secretCron}\n`, { mode: 0o644 });
      const found = runCronInspector(root, [], [cronDirectory]);
      expect(found.status).toBe(10);
      expect(`${found.stdout}${found.stderr}`).not.toContain(secretCron);

      writeFileSync(target, '#!/bin/sh\nexit 0\n', { mode: 0o664 });
      chmodSync(target, 0o664);
      const writable = runCronInspector(root, [], [cronDirectory]);
      expect(writable.status).toBe(20);
      expect(`${writable.stdout}${writable.stderr}`).toBe('');

      chmodSync(target, 0o644);
      chmodSync(cronDirectory, 0o770);
      const mutableSource = runCronInspector(root, [], [cronDirectory]);
      expect(mutableSource.status).toBe(20);
      expect(`${mutableSource.stdout}${mutableSource.stderr}`).toBe('');

      chmodSync(cronDirectory, 0o700);
      chmodSync(packageDirectory, 0o770);
      const mutableParent = runCronInspector(root, [], [cronDirectory]);
      expect(mutableParent.status).toBe(20);
      expect(`${mutableParent.stdout}${mutableParent.stderr}`).toBe('');

      chmodSync(packageDirectory, 0o700);
      const realPackageDirectory = join(root, 'real-package');
      const intermediateLink = join(root, 'package-link');
      const intermediateTarget = join(realPackageDirectory, 'package-cron');
      mkdirSync(realPackageDirectory, { mode: 0o700 });
      writeFileSync(intermediateTarget, '#!/bin/sh\nexit 0\n', { mode: 0o644 });
      symlinkSync(realPackageDirectory, intermediateLink);
      rmSync(link);
      symlinkSync(join(intermediateLink, 'package-cron'), link);
      const intermediateSymlink = runCronInspector(root, [], [cronDirectory]);
      expect(intermediateSymlink.status).toBe(20);
      expect(`${intermediateSymlink.stdout}${intermediateSymlink.stderr}`).toBe('');

      rmSync(link);
      symlinkSync(join(packageDirectory, 'missing-cron'), link);
      const dangling = runCronInspector(root, [], [cronDirectory]);
      expect(dangling.status).toBe(20);
      expect(`${dangling.stdout}${dangling.stderr}`).toBe('');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
