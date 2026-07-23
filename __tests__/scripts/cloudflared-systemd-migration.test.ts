import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = 'scripts/cloudflared-systemd-migrate.sh';
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
      expect(script).toContain(`"${source}"`);
    }
    expect(script).toContain('INSPECTION_ERROR = 20');
    expect(script).not.toContain('crontab -u "$legacy_user" -l');
  });
});
