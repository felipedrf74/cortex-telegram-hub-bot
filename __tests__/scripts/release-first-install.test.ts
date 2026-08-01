import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// Every assertion in this file executes the shipped shell scripts. Nothing here
// inspects script source text: the transaction is either run outright, or
// sourced in its explicit library mode so its real guard functions run against
// real on-disk fixtures.
const TRANSACTION = path.resolve('scripts/remote-user-release-transaction.sh');
const OPERATOR = path.resolve('scripts/release-operator.sh');
const STAGING_BASE = '/home/dominguez/telegram-hub-bot-staging';
const PRODUCTION_BASE = '/home/dominguez/telegram-hub-bot';
const REMOTE_BUNDLE = '/home/dominguez/.local/share/nexus-release/incoming/bundle';
const RUNTIME_SHA = 'a'.repeat(40);
const ARTIFACT_DIGEST = 'b'.repeat(64);
const PREDECESSOR_SHA = 'c'.repeat(40);
const PREDECESSOR_DIGEST = 'd'.repeat(64);
const TRANSACTION_ID = '20260801T120000Z-0123456789ab';
// The only host probe this suite cannot satisfy on a developer machine. Reaching
// it proves the run passed every earlier argument and predecessor guard.
const HOST_PROBE_REFUSAL = 'Sonar release-state monitor is unavailable';

const REFUSED_BY_RELEASE_STORE =
  'first install is refused because an installed staging release already exists';
const REFUSED_BY_UNINSPECTABLE_STORE =
  'first install is refused because the staging release store could not be fully inspected';
const REFUSED_BY_LIVE_RUNTIME =
  'first install is refused because a staging runtime process is registered with PM2';
const REFUSED_BY_UNQUERYABLE_PM2 =
  'first install is refused because PM2 could not be queried';
const REFUSED_BY_UNREADABLE_PM2 =
  'first install is refused because the PM2 process table could not be interpreted';

const LIBRARY_MODE_REFUSAL =
  'library mode requires this file to be sourced';
// Bash's own complaint about a top-level `return`. It was the only thing that
// stopped an accidental library-mode execution, and by then every lock and host
// probe had already been skipped.
const SOURCED_ONLY_BASH_ERROR = "can only `return'";

const ABORTED_BY_LATE_SELECTOR =
  'first install is refused because a current staging selector appeared '
  + 'while the candidate was prepared';
const ABORTED_BY_LATE_RUNTIME =
  'first install is refused because a staging runtime process is registered with PM2';

// A root-owned run bypasses directory mode bits entirely, so the unreadable
// release-store fixture cannot be built there. It is the only case in this file
// that depends on being an unprivileged user.
const UNPRIVILEGED = typeof process.getuid === 'function' && process.getuid() !== 0;

const roots: string[] = [];

function temporaryRoot(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-first-install-')));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'releases'), { recursive: true });
  return root;
}

function releaseName(sha: string, digest: string): string {
  return `${sha}-${digest.slice(0, 12)}`;
}

function completionReceipt(
  sha: string,
  digest: string,
  schema = 'nexus.release-bundle.v1',
): string {
  return `${JSON.stringify({
    schema,
    runtimeSha: sha,
    artifactDigest: digest,
    packageVersion: '4.14.208',
    fileCount: 1,
    createdAt: '2026-08-01T12:00:00.000Z',
  }, null, 2)}\n`;
}

function installCompletedRelease(
  root: string,
  sha: string,
  digest: string,
  schema?: string,
): string {
  const release = path.join(root, 'releases', releaseName(sha, digest));
  fs.mkdirSync(release, { recursive: true });
  fs.writeFileSync(path.join(release, '.complete.json'), completionReceipt(sha, digest, schema));
  return release;
}

type Pm2Fixture = 'empty' | 'role-online' | 'unqueryable' | 'unreadable';

// The PM2 shim answers from this file on every call rather than from a value
// baked in at fixture time. That is what lets a test change PM2's answer between
// the transaction's early guard and its pre-switch re-check, which is exactly
// the window the re-check exists to close.
function pm2FixtureFile(root: string): string {
  return path.join(root, 'pm2-fixture');
}

// The transaction reaches PM2 through its documented host-binary overrides.
// These shims are the only way to give its liveness probe a deterministic answer
// on a developer machine; the timeout shim exists because macOS ships no
// coreutils `timeout`, which the probe always wraps PM2 in.
function hostRuntimeShims(root: string, pm2: Pm2Fixture = 'empty'): NodeJS.ProcessEnv {
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const timeoutBin = path.join(bin, 'timeout');
  fs.writeFileSync(timeoutBin, [
    '#!/bin/bash',
    'while [ "$#" -gt 0 ]; do',
    '  case "$1" in',
    '    --foreground) shift ;;',
    '    [0-9]*s) shift ;;',
    '    *) break ;;',
    '  esac',
    'done',
    'exec "$@"',
    '',
  ].join('\n'), { mode: 0o700 });
  const fixture = pm2FixtureFile(root);
  fs.writeFileSync(fixture, pm2);
  const roleOnline = JSON.stringify([
    { name: 'nexus-hub-staging', pid: 4242, pm2_env: { status: 'online' } },
    { name: 'content-engine-staging', pid: 4243, pm2_env: { status: 'online' } },
  ]);
  const pm2Bin = path.join(bin, 'pm2');
  fs.writeFileSync(pm2Bin, [
    '#!/bin/bash',
    '[ "$1" = jlist ] || exit 0',
    `case "$(cat ${JSON.stringify(fixture)})" in`,
    "  empty) printf '%s\\n' '[]' ;;",
    `  role-online) printf '%s\\n' '${roleOnline}' ;;`,
    '  unqueryable) echo "pm2 daemon is unreachable" >&2; exit 1 ;;',
    "  unreadable) printf '%s\\n' 'pm2 printed a banner instead of JSON' ;;",
    '  *) exit 1 ;;',
    'esac',
    '',
  ].join('\n'), { mode: 0o700 });
  return { NEXUS_RELEASE_PM2_BIN: pm2Bin, NEXUS_RELEASE_TIMEOUT_BIN: timeoutBin };
}

// A harness line that changes PM2's answer part-way through a sourced run.
function setPm2Fixture(root: string, pm2: Pm2Fixture): string {
  return `printf '%s' ${JSON.stringify(pm2)} > ${JSON.stringify(pm2FixtureFile(root))}`;
}

function firstInstallEnvironment(root: string, pm2: Pm2Fixture = 'empty'): NodeJS.ProcessEnv {
  return { ...hostRuntimeShims(root, pm2), NEXUS_RELEASE_ALLOW_FIRST_INSTALL: '1' };
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop()!;
    // A fixture may deliberately leave a directory unreadable.
    try {
      fs.chmodSync(path.join(root, 'releases'), 0o700);
    } catch {
      // The fixture did not create or restrict a release store.
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function baseEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    // The transaction resolves these host binaries through documented
    // overrides. The Sonar release-state monitor is deliberately not
    // overridable, so it stays the terminal probe for these runs.
    NEXUS_RELEASE_PM2_BIN: '/bin/echo',
    NEXUS_RELEASE_NODE_BIN: process.execPath,
    NEXUS_RELEASE_PYTHON_BIN: '/bin/echo',
    NEXUS_RELEASE_TIMEOUT_BIN: '/bin/echo',
  };
}

function stageArguments(
  predecessor: string[] = [PREDECESSOR_SHA, PREDECESSOR_DIGEST],
): string[] {
  return [
    'stage', STAGING_BASE, REMOTE_BUNDLE, RUNTIME_SHA, ARTIFACT_DIGEST,
    TRANSACTION_ID, '15', ...predecessor,
  ];
}

function execute(
  argv: string[],
  environment: NodeJS.ProcessEnv = {},
): SpawnSyncReturns<string> {
  return spawnSync('bash', [TRANSACTION, ...argv], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...baseEnvironment(), ...environment },
  });
}

// Executes the transaction the way the old containment comment claimed was
// impossible: a bare script name that bash has to resolve through PATH. That
// leaves $0 as the name typed on the command line while BASH_SOURCE[0] holds the
// absolute path bash found, so the two differ for an ordinary execution.
function executeThroughPath(
  argv: string[],
  environment: NodeJS.ProcessEnv = {},
): SpawnSyncReturns<string> {
  return spawnSync('bash', [path.basename(TRANSACTION), ...argv], {
    // Deliberately not the scripts directory: bash opens a script found relative
    // to the working directory without consulting PATH at all.
    cwd: os.tmpdir(),
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...baseEnvironment(),
      ...environment,
      PATH: `${path.dirname(TRANSACTION)}:${process.env.PATH ?? ''}`,
    },
  });
}

function sourced(
  body: string[],
  options: {
    argv?: string[];
    environment?: NodeJS.ProcessEnv;
  } = {},
): SpawnSyncReturns<string> {
  const script = [
    'set -euo pipefail',
    'source "$1" "${@:2}"',
    ...body,
  ].join('\n');
  return spawnSync('bash', [
    '-c',
    script,
    'first-install-harness',
    TRANSACTION,
    ...(options.argv ?? stageArguments()),
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...baseEnvironment(),
      NEXUS_RELEASE_TRANSACTION_LIBRARY_MODE: '1',
      ...(options.environment ?? {}),
    },
  });
}

function harnessPreamble(root: string): string[] {
  return [
    `BASE_DIR=${JSON.stringify(root)}`,
    'CURRENT_LINK="$BASE_DIR/current"',
    'STATE_FILE="$BASE_DIR/state.json"',
    'RELEASE_DIR="$BASE_DIR/releases/$RUNTIME_SHA-${ARTIFACT_DIGEST:0:12}"',
  ];
}

describe('release transaction first-install mode', () => {
  describe('executed transaction argument guards', () => {
    it('still refuses a missing predecessor identity when the opt-in is absent', () => {
      const result = execute(stageArguments(['', '']));

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('expected staging predecessor SHA is invalid');
      expect(result.stderr).not.toContain(HOST_PROBE_REFUSAL);
    });

    it('still refuses a missing predecessor digest when the opt-in is absent', () => {
      const result = execute(stageArguments([PREDECESSOR_SHA, '']));

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('expected staging predecessor digest is invalid');
    });

    it('accepts absent predecessor identity only under the explicit opt-in', () => {
      const result = execute(stageArguments(['', '']), {
        NEXUS_RELEASE_ALLOW_FIRST_INSTALL: '1',
      });

      expect(result.status).toBe(1);
      expect(result.stderr).not.toContain('predecessor SHA is invalid');
      expect(result.stderr).not.toContain('predecessor digest is invalid');
      // It advanced all the way to the host probe it cannot satisfy here, which
      // proves the predecessor argument guard no longer stops it.
      expect(result.stderr).toContain(HOST_PROBE_REFUSAL);
    });

    it('refuses a first install that also carries a predecessor identity', () => {
      const result = execute(stageArguments(), {
        NEXUS_RELEASE_ALLOW_FIRST_INSTALL: '1',
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        'first install must not receive an expected staging predecessor identity',
      );
      expect(result.stderr).not.toContain(HOST_PROBE_REFUSAL);
    });

    it('refuses a production first install outright', () => {
      const result = execute([
        'promote', PRODUCTION_BASE, REMOTE_BUNDLE, RUNTIME_SHA, ARTIFACT_DIGEST,
        TRANSACTION_ID, '60', '', '',
      ], { NEXUS_RELEASE_ALLOW_FIRST_INSTALL: '1' });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('first install is refused for production');
      expect(result.stderr).not.toContain(HOST_PROBE_REFUSAL);
    });

    it('refuses a production first install even with a valid predecessor identity', () => {
      // Second production guard: the role refusal is unconditional, and runs
      // before the argument shape is even considered.
      const result = execute([
        'promote', PRODUCTION_BASE, REMOTE_BUNDLE, RUNTIME_SHA, ARTIFACT_DIGEST,
        TRANSACTION_ID, '60', PREDECESSOR_SHA, PREDECESSOR_DIGEST,
      ], { NEXUS_RELEASE_ALLOW_FIRST_INSTALL: '1' });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('first install is refused for production');
      expect(result.stderr).not.toContain(HOST_PROBE_REFUSAL);
    });

    it('keeps promote-exact-release.sh structurally unable to request a first install', () => {
      // Third production guard: the promote entry point never forwards the
      // opt-in and always sends a canonical predecessor identity, so the
      // transaction's non-first-install branch validates it as a full SHA and
      // digest. Production cannot reach first install even by mistake.
      const promote = fs.readFileSync(path.resolve('scripts/promote-exact-release.sh'), 'utf8');

      expect(promote).not.toContain('NEXUS_RELEASE_ALLOW_FIRST_INSTALL');
      expect(promote).toContain(
        '"$STABILITY_SECONDS" "$EXPECTED_PREDECESSOR_SHA" "$EXPECTED_PREDECESSOR_DIGEST"',
      );
    });

    it('refuses to run the fault drill during a first install', () => {
      const result = execute(stageArguments(['', '']), {
        NEXUS_RELEASE_ALLOW_FIRST_INSTALL: '1',
        NEXUS_RELEASE_FAULT_AFTER_SWITCH: 'staging-health',
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('first install cannot run the release fault drill');
      expect(result.stderr).not.toContain(HOST_PROBE_REFUSAL);
    });

    it('refuses a malformed first-install opt-in instead of silently ignoring it', () => {
      const result = execute(stageArguments(['', '']), {
        NEXUS_RELEASE_ALLOW_FIRST_INSTALL: 'yes',
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('first-install opt-in must be unset, 0, or 1');
    });

    it('leaves the normal staged path unchanged when the opt-in is absent', () => {
      const result = execute(stageArguments());

      expect(result.status).toBe(1);
      expect(result.stderr).not.toContain('predecessor SHA is invalid');
      expect(result.stderr).not.toContain('first install');
      expect(result.stderr).toContain(HOST_PROBE_REFUSAL);
    });

    it('never enters library mode when the transaction is executed', () => {
      const result = execute(stageArguments(['', '']), {
        NEXUS_RELEASE_TRANSACTION_LIBRARY_MODE: '1',
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(LIBRARY_MODE_REFUSAL);
      expect(result.stderr).not.toContain(SOURCED_ONLY_BASH_ERROR);
    });
  });

  // Library mode skips the flock release mutex, the shared root Sonar lock, the
  // Sonar Compute Engine gate, and every host-binary probe. Its containment used
  // to rest on the claim that "an executed Bash script always has BASH_SOURCE[0]
  // equal to $0", which is false, so an execution could silently engage it.
  describe('library mode is source-only', () => {
    // The arguments a first install really uses. They pass every argument guard,
    // so the run reaches the point where library mode and a real execution
    // visibly diverge instead of dying earlier for an unrelated reason.
    const VALID_FIRST_INSTALL = stageArguments(['', '']);
    const FIRST_INSTALL_ON = { NEXUS_RELEASE_ALLOW_FIRST_INSTALL: '1' };

    it('refuses a PATH-resolved execution that sets the library-mode variable', () => {
      const result = executeThroughPath(VALID_FIRST_INSTALL, {
        ...FIRST_INSTALL_ON,
        NEXUS_RELEASE_TRANSACTION_LIBRARY_MODE: '1',
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(LIBRARY_MODE_REFUSAL);
      // The only thing that used to stop this invocation was bash rejecting the
      // top-level `return` at the end of library mode, which means every lock and
      // host probe had already been skipped by then.
      expect(result.stderr).not.toContain(SOURCED_ONLY_BASH_ERROR);
      // It must not have advanced into the release flow either.
      expect(result.stderr).not.toContain(HOST_PROBE_REFUSAL);
    });

    it('refuses before parsing arguments so no invocation shape can slip through', () => {
      const result = executeThroughPath(['definitely-not-a-command'], {
        NEXUS_RELEASE_TRANSACTION_LIBRARY_MODE: '1',
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(LIBRARY_MODE_REFUSAL);
      expect(result.stderr).not.toContain('usage:');
    });

    it('leaves a PATH-resolved execution untouched when the variable is absent', () => {
      const result = executeThroughPath(VALID_FIRST_INSTALL, FIRST_INSTALL_ON);

      expect(result.status).toBe(1);
      expect(result.stderr).not.toContain(LIBRARY_MODE_REFUSAL);
      expect(result.stderr).not.toContain(SOURCED_ONLY_BASH_ERROR);
      // It ran the real flow and stopped at the host probe it cannot satisfy
      // here, exactly as an absolute-path execution does.
      expect(result.stderr).toContain(HOST_PROBE_REFUSAL);
    });

    it('still engages for a genuine source, which is the only supported use', () => {
      const root = temporaryRoot();
      const result = sourced([
        ...harnessPreamble(root),
        'printf "%s\\n" "$LIBRARY_MODE"',
      ], { argv: VALID_FIRST_INSTALL, environment: firstInstallEnvironment(root) });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe('true');
    });

    it('no longer rests containment on the false BASH_SOURCE claim', () => {
      // Independent proof that the retired test was wrong, measured on a
      // throwaway script so it cannot be confused with the transaction's own
      // behaviour: a PATH-resolved execution has $0 different from
      // BASH_SOURCE[0], which is precisely what the old guard accepted as
      // evidence of sourcing.
      const root = temporaryRoot();
      const probe = path.join(root, 'bash-source-probe.sh');
      fs.writeFileSync(probe, [
        '#!/usr/bin/env bash',
        'if [ "${BASH_SOURCE[0]}" = "$0" ]; then echo equal; else echo different; fi',
        'if (return 0 2>/dev/null); then echo sourced; else echo executed; fi',
        '',
      ].join('\n'), { mode: 0o700 });
      const executed = spawnSync('bash', ['bash-source-probe.sh'], {
        cwd: os.tmpdir(),
        encoding: 'utf8',
        env: { ...process.env, PATH: `${root}:${process.env.PATH ?? ''}` },
      });

      expect(executed.stdout.trim().split('\n')).toEqual(['different', 'executed']);
      expect(fs.readFileSync(TRANSACTION, 'utf8'))
        .not.toContain('always has BASH_SOURCE[0] equal to $0');
    });
  });

  describe('predecessor resolution', () => {
    it('dies with the unchanged message when no predecessor exists and the opt-in is absent', () => {
      const root = temporaryRoot();
      const result = sourced([...harnessPreamble(root), 'resolve_predecessor']);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('staging predecessor is unavailable');
    });

    it('records a first install when the host has genuinely never released', () => {
      const root = temporaryRoot();
      const result = sourced([
        ...harnessPreamble(root),
        'resolve_predecessor',
        'printf "first-install=%s predecessor=[%s] sha=[%s] digest=[%s] readiness=%s\\n" '
        + '"$FIRST_INSTALL" "$PREDECESSOR" "$PREDECESSOR_SHA" "$PREDECESSOR_DIGEST" '
        + '"$ROLLBACK_READINESS"',
      ], {
        argv: stageArguments(['', '']),
        environment: firstInstallEnvironment(root),
      });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe(
        'first-install=true predecessor=[] sha=[] digest=[] readiness=not_applicable',
      );
    });

    it('treats incomplete leftover release directories as no predecessor', () => {
      const root = temporaryRoot();
      // Exactly the stuck ServerDominguez staging shape: release directories
      // exist but none of them ever produced a .complete.json receipt.
      for (const name of ['first', 'second', 'third']) {
        fs.mkdirSync(path.join(root, 'releases', `${'e'.repeat(40)}-${name.padEnd(12, 'f')}`));
      }
      const result = sourced([
        ...harnessPreamble(root),
        'resolve_predecessor',
        'printf "%s\\n" "$FIRST_INSTALL"',
      ], {
        argv: stageArguments(['', '']),
        environment: firstInstallEnvironment(root),
      });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe('true');
    });

    it('refuses first install when a valid predecessor is already current', () => {
      const root = temporaryRoot();
      const release = installCompletedRelease(root, PREDECESSOR_SHA, PREDECESSOR_DIGEST);
      fs.symlinkSync(release, path.join(root, 'current'));
      const result = sourced([...harnessPreamble(root), 'resolve_predecessor'], {
        argv: stageArguments(['', '']),
        environment: firstInstallEnvironment(root),
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        'first install is refused because an established staging predecessor exists',
      );
    });

    it('refuses first install when a completed release exists without a current selector', () => {
      const root = temporaryRoot();
      installCompletedRelease(root, PREDECESSOR_SHA, PREDECESSOR_DIGEST);
      const result = sourced([...harnessPreamble(root), 'resolve_predecessor'], {
        argv: stageArguments(['', '']),
        environment: firstInstallEnvironment(root),
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(REFUSED_BY_RELEASE_STORE);
    });

    it('refuses first install when the current selector exists as a real directory', () => {
      const root = temporaryRoot();
      fs.mkdirSync(path.join(root, 'current'));
      const result = sourced([...harnessPreamble(root), 'resolve_predecessor'], {
        argv: stageArguments(['', '']),
        environment: firstInstallEnvironment(root),
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        'first install is refused because a current staging selector already exists',
      );
    });

    it('still refuses a current selector that points outside the release store', () => {
      const root = temporaryRoot();
      const outside = path.join(root, 'outside');
      fs.mkdirSync(outside);
      fs.symlinkSync(outside, path.join(root, 'current'));
      const result = sourced([...harnessPreamble(root), 'resolve_predecessor'], {
        argv: stageArguments(['', '']),
        environment: firstInstallEnvironment(root),
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('current staging selector is unsafe');
    });

    it('still binds an existing predecessor to the protected release state', () => {
      const root = temporaryRoot();
      const release = installCompletedRelease(root, PREDECESSOR_SHA, PREDECESSOR_DIGEST);
      fs.symlinkSync(release, path.join(root, 'current'));
      const result = sourced([...harnessPreamble(root), 'resolve_predecessor'], {
        argv: stageArguments(['f'.repeat(40), PREDECESSOR_DIGEST]),
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        'observed staging predecessor SHA does not match protected release state',
      );
    });

    it('still verifies predecessor artifact identity before arming rollback', () => {
      const root = temporaryRoot();
      const release = installCompletedRelease(root, PREDECESSOR_SHA, PREDECESSOR_DIGEST);
      fs.symlinkSync(release, path.join(root, 'current'));
      const result = sourced([...harnessPreamble(root), 'resolve_predecessor']);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        'staging predecessor artifact or dependency identity is not rollback-ready',
      );
    });
  });

  // Every fixture below is the same adversarial shape: a staging host that HAS
  // released, whose `current` selector is gone. The guard used to answer "has
  // this host ever released?" by trying to VALIDATE a completion receipt and
  // treating every validation failure as "no". Each of these breaks a different
  // validation rule while leaving the host unmistakably released, and each one
  // therefore used to be waved through into switch_current and start_runtime
  // with no rollback target.
  describe('first install fails closed on a released host', () => {
    function refusal(root: string, pm2: Pm2Fixture = 'empty'): SpawnSyncReturns<string> {
      return sourced([...harnessPreamble(root), 'resolve_predecessor'], {
        argv: stageArguments(['', '']),
        environment: firstInstallEnvironment(root, pm2),
      });
    }

    it('refuses when the completion receipt is truncated to zero bytes', () => {
      const root = temporaryRoot();
      const release = installCompletedRelease(root, PREDECESSOR_SHA, PREDECESSOR_DIGEST);
      fs.truncateSync(path.join(release, '.complete.json'), 0);
      expect(fs.statSync(path.join(release, '.complete.json')).size).toBe(0);

      const result = refusal(root);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(REFUSED_BY_RELEASE_STORE);
    });

    it('refuses when the release directory was renamed and the receipt is intact', () => {
      const root = temporaryRoot();
      const release = installCompletedRelease(root, PREDECESSOR_SHA, PREDECESSOR_DIGEST);
      fs.renameSync(release, `${release}.bak`);
      expect(fs.existsSync(path.join(`${release}.bak`, '.complete.json'))).toBe(true);

      const result = refusal(root);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(REFUSED_BY_RELEASE_STORE);
    });

    it('refuses when the completion receipt is a symbolic link to a valid receipt', () => {
      const root = temporaryRoot();
      const release = installCompletedRelease(root, PREDECESSOR_SHA, PREDECESSOR_DIGEST);
      const marker = path.join(release, '.complete.json');
      const stored = path.join(root, 'stored-receipt.json');
      fs.renameSync(marker, stored);
      fs.symlinkSync(stored, marker);
      expect(fs.lstatSync(marker).isSymbolicLink()).toBe(true);

      const result = refusal(root);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(REFUSED_BY_RELEASE_STORE);
    });

    it('refuses when the release lives outside the store behind a symbolic entry', () => {
      const root = temporaryRoot();
      const name = releaseName(PREDECESSOR_SHA, PREDECESSOR_DIGEST);
      const outside = path.join(root, 'elsewhere', name);
      fs.mkdirSync(outside, { recursive: true });
      fs.writeFileSync(
        path.join(outside, '.complete.json'),
        completionReceipt(PREDECESSOR_SHA, PREDECESSOR_DIGEST),
      );
      fs.symlinkSync(outside, path.join(root, 'releases', name));

      const result = refusal(root);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(REFUSED_BY_RELEASE_STORE);
    });

    it('refuses when the receipt parses but declares a future bundle schema', () => {
      const root = temporaryRoot();
      installCompletedRelease(
        root,
        PREDECESSOR_SHA,
        PREDECESSOR_DIGEST,
        'nexus.release-bundle.v2',
      );

      const result = refusal(root);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(REFUSED_BY_RELEASE_STORE);
    });

    it.skipIf(!UNPRIVILEGED)('refuses when the release store cannot be read at all', () => {
      const root = temporaryRoot();
      installCompletedRelease(root, PREDECESSOR_SHA, PREDECESSOR_DIGEST);
      const releases = path.join(root, 'releases');
      fs.chmodSync(releases, 0o000);

      const result = refusal(root);

      fs.chmodSync(releases, 0o700);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(REFUSED_BY_UNINSPECTABLE_STORE);
    });

    it.skipIf(!UNPRIVILEGED)('refuses when a single release directory cannot be read', () => {
      const root = temporaryRoot();
      const release = installCompletedRelease(root, PREDECESSOR_SHA, PREDECESSOR_DIGEST);
      fs.chmodSync(release, 0o000);

      const result = refusal(root);

      fs.chmodSync(release, 0o700);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(REFUSED_BY_UNINSPECTABLE_STORE);
    });

    it('refuses when a role application is online in PM2', () => {
      // No filesystem evidence at all: PM2 is the only witness that this host
      // is already serving traffic, and it is the witness the guard never asked.
      const root = temporaryRoot();

      const result = refusal(root, 'role-online');

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(REFUSED_BY_LIVE_RUNTIME);
    });

    it('refuses when PM2 cannot be queried', () => {
      const root = temporaryRoot();

      const result = refusal(root, 'unqueryable');

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(REFUSED_BY_UNQUERYABLE_PM2);
    });

    it('refuses when the PM2 process table cannot be interpreted', () => {
      const root = temporaryRoot();

      const result = refusal(root, 'unreadable');

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(REFUSED_BY_UNREADABLE_PM2);
    });

    it('still allows the one legitimate case: a genuinely virgin host', () => {
      const root = temporaryRoot();
      expect(fs.readdirSync(path.join(root, 'releases'))).toEqual([]);

      const result = sourced([
        ...harnessPreamble(root),
        'resolve_predecessor',
        'printf "%s %s\\n" "$FIRST_INSTALL" "$ROLLBACK_READINESS"',
      ], {
        argv: stageArguments(['', '']),
        environment: firstInstallEnvironment(root),
      });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe('true not_applicable');
    });

    it('still allows a virgin host whose release store does not exist yet', () => {
      const root = temporaryRoot();
      fs.rmSync(path.join(root, 'releases'), { recursive: true, force: true });

      const result = sourced([
        ...harnessPreamble(root),
        'resolve_predecessor',
        'printf "%s\\n" "$FIRST_INSTALL"',
      ], {
        argv: stageArguments(['', '']),
        environment: firstInstallEnvironment(root),
      });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe('true');
    });
  });

  // The guards in begin_transaction run minutes before the switch on a real
  // bundle: between them the transaction copies the whole artifact, verifies the
  // bundle manifest, and builds a Python virtual environment. Nothing outside the
  // transaction takes the release mutex, so the host can go live inside that
  // window - a reboot replays `pm2 resurrect`, or somebody starts the legacy
  // runtime by hand - and a first install has no restore path once it has
  // switched `current` and pm2-deleted the live apps.
  describe('first install re-checks the host immediately before the switch', () => {
    function afterWindow(
      root: string,
      window: string[],
      pm2: Pm2Fixture = 'empty',
    ): SpawnSyncReturns<string> {
      return sourced([
        ...harnessPreamble(root),
        // The early guard, exactly as begin_transaction runs it.
        'resolve_predecessor',
        // The candidate is prepared and moved into place before the switch.
        'mkdir -p "$RELEASE_DIR"',
        'printf "%s\\n" candidate > "$RELEASE_DIR/.complete.json"',
        // Everything the transaction cannot see happens here.
        ...window,
        'recheck_first_install_host',
        'printf "reached-switch\\n"',
      ], {
        argv: stageArguments(['', '']),
        environment: firstInstallEnvironment(root, pm2),
      });
    }

    it('refuses when a current selector appears while the candidate is prepared', () => {
      const root = temporaryRoot();

      const result = afterWindow(root, ['ln -s "$RELEASE_DIR" "$CURRENT_LINK"']);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(ABORTED_BY_LATE_SELECTOR);
      expect(result.stdout).not.toContain('reached-switch');
    });

    it('refuses when a plain directory takes the current selector name', () => {
      const root = temporaryRoot();

      const result = afterWindow(root, ['mkdir "$CURRENT_LINK"']);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(ABORTED_BY_LATE_SELECTOR);
    });

    it('refuses when a dangling selector symlink appears', () => {
      const root = temporaryRoot();

      const result = afterWindow(root, ['ln -s "$BASE_DIR/nowhere" "$CURRENT_LINK"']);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(ABORTED_BY_LATE_SELECTOR);
    });

    it('refuses when a role application comes online while the candidate is prepared', () => {
      const root = temporaryRoot();

      const result = afterWindow(root, [setPm2Fixture(root, 'role-online')]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(ABORTED_BY_LATE_RUNTIME);
      expect(result.stdout).not.toContain('reached-switch');
    });

    it('fails closed when PM2 stops answering inside the window', () => {
      const root = temporaryRoot();

      const result = afterWindow(root, [setPm2Fixture(root, 'unqueryable')]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(REFUSED_BY_UNQUERYABLE_PM2);
    });

    it('fails closed when the PM2 process table stops being interpretable', () => {
      const root = temporaryRoot();

      const result = afterWindow(root, [setPm2Fixture(root, 'unreadable')]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(REFUSED_BY_UNREADABLE_PM2);
    });

    it('proceeds to the switch when the host is still virgin', () => {
      const root = temporaryRoot();

      const result = afterWindow(root, []);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('reached-switch');
    });

    it('aborts before any mutation and records why', () => {
      const root = temporaryRoot();
      const survivor = path.join(root, 'releases', releaseName('9'.repeat(40), '8'.repeat(64)));
      fs.mkdirSync(survivor, { recursive: true });

      const result = afterWindow(root, [setPm2Fixture(root, 'role-online')]);

      expect(result.status).toBe(1);
      const state = JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8'));
      expect(state).toMatchObject({
        firstInstall: true,
        phase: 'first_install_aborted',
        status: 'failed',
        predecessor: null,
        predecessorSha: null,
        predecessorDigest: null,
      });
      expect(state.message).toContain('before runtime mutation');
      expect(state.message).toContain('a staging runtime process is registered with PM2');
      // It must never borrow the post-mutation wording: that receipt tells an
      // operator the host is stranded with no predecessor, which is not true here.
      expect(state.phase).not.toBe('first_install_failed');
      expect(state.rollbackResult).not.toBe('unavailable');
      // Nothing was switched or started, so `current` is still absent.
      expect(fs.existsSync(path.join(root, 'current'))).toBe(false);
      // Only the candidate this transaction created is removed, which returns the
      // release store to the shape the run found it in.
      expect(state.candidateRemoved).toBe(true);
      expect(fs.existsSync(path.join(
        root,
        'releases',
        releaseName(RUNTIME_SHA, ARTIFACT_DIGEST),
      ))).toBe(false);
      expect(fs.existsSync(survivor)).toBe(true);
    });

    it('is inert for a normal staged release even on a live host', () => {
      const root = temporaryRoot();
      const release = installCompletedRelease(root, PREDECESSOR_SHA, PREDECESSOR_DIGEST);
      fs.symlinkSync(release, path.join(root, 'current'));

      const result = sourced([
        ...harnessPreamble(root),
        // A normal release has a predecessor, a live runtime, and a current
        // selector by definition. The re-check must not touch that path.
        'FIRST_INSTALL=false',
        'recheck_first_install_host',
        'printf "reached-switch\\n"',
      ], { environment: hostRuntimeShims(root, 'role-online') });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('reached-switch');
    });

    it('runs between the switching journal entry and the irreversible switch', () => {
      // Ordering is the whole point of this guard and cannot be observed from a
      // sourced function call, so it is asserted against the shipped sequence.
      const transaction = fs.readFileSync(TRANSACTION, 'utf8');
      const journal = transaction.indexOf('PHASE=switching');
      const recheck = transaction.indexOf('recheck_first_install_host\n', journal);
      const armed = transaction.indexOf('ROLLBACK_ARMED=true', journal);
      const switched = transaction.indexOf('switch_current "$RELEASE_DIR"', journal);
      const started = transaction.indexOf('start_runtime "$RELEASE_DIR"', journal);

      expect(journal).toBeGreaterThan(-1);
      expect(recheck).toBeGreaterThan(journal);
      expect(recheck).toBeLessThan(armed);
      expect(armed).toBeLessThan(switched);
      expect(switched).toBeLessThan(started);
    });
  });

  // A refusal is a decision not to act. It must therefore leave the host's
  // recorded release identity exactly as it found it: release-operator.sh reads
  // predecessorSha out of that file, and a receipt that says null makes it fall
  // back to the production SHA and wedge every later normal release.
  describe('a refused first install is side-effect-free', () => {
    const SEEDED_STATE = `${JSON.stringify({
      schema: 'nexus.lean-release-transaction.v1',
      role: 'staging',
      transactionId: '20260731T090000Z-fedcba987654',
      runtimeSha: PREDECESSOR_SHA,
      artifactDigest: PREDECESSOR_DIGEST,
      releaseDir: `/home/dominguez/telegram-hub-bot-staging/releases/${
        releaseName(PREDECESSOR_SHA, PREDECESSOR_DIGEST)}`,
      firstInstall: false,
      predecessor: '/home/dominguez/telegram-hub-bot-staging/releases/previous',
      predecessorSha: 'e'.repeat(40),
      predecessorDigest: 'f'.repeat(64),
      phase: 'completed',
      status: 'passed',
      message: null,
    }, null, 2)}\n`;

    it('leaves a pre-existing state file byte-identical when it refuses', () => {
      const root = temporaryRoot();
      installCompletedRelease(root, PREDECESSOR_SHA, PREDECESSOR_DIGEST);
      const stateFile = path.join(root, 'state.json');
      fs.writeFileSync(stateFile, SEEDED_STATE);
      const before = fs.readFileSync(stateFile);

      // begin_transaction is the shipped pre-mutation sequence, executed here in
      // full: the refusal guards, the EXIT trap, and the first state write, in
      // the order the transaction runs them.
      const result = sourced([...harnessPreamble(root), 'begin_transaction'], {
        argv: stageArguments(['', '']),
        environment: firstInstallEnvironment(root),
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(REFUSED_BY_RELEASE_STORE);
      expect(fs.readFileSync(stateFile).equals(before)).toBe(true);
      expect(fs.readdirSync(root).filter((entry) => entry.startsWith('state.json.'))).toEqual([]);
    });

    it('leaves the state file byte-identical when PM2 reports a live role app', () => {
      const root = temporaryRoot();
      const stateFile = path.join(root, 'state.json');
      fs.writeFileSync(stateFile, SEEDED_STATE);
      const before = fs.readFileSync(stateFile);

      const result = sourced([...harnessPreamble(root), 'begin_transaction'], {
        argv: stageArguments(['', '']),
        environment: firstInstallEnvironment(root, 'role-online'),
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(REFUSED_BY_LIVE_RUNTIME);
      expect(fs.readFileSync(stateFile).equals(before)).toBe(true);
    });

    it('still writes a pre-mutation failure receipt with a usable predecessor', () => {
      // The complement of the two cases above: reordering the refusal guards
      // ahead of the EXIT trap must not stop a normal staged release from
      // journalling its own aborts, and that receipt still has to carry the
      // predecessor identity release-operator.sh reads back.
      const root = temporaryRoot();
      const release = installCompletedRelease(root, PREDECESSOR_SHA, PREDECESSOR_DIGEST);
      fs.symlinkSync(release, path.join(root, 'current'));
      const result = sourced([
        ...harnessPreamble(root),
        // The real bundle verifier needs the uploaded host artifact; every
        // other step of begin_transaction runs unmodified.
        'verify_pristine_bundle() { :; }',
        'begin_transaction',
      ], { environment: hostRuntimeShims(root) });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        'staging predecessor artifact or dependency identity is not rollback-ready',
      );
      const state = JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8'));
      expect(state).toMatchObject({
        firstInstall: false,
        phase: 'preparing',
        status: 'failed',
        message: 'transaction stopped before runtime mutation',
        predecessorSha: PREDECESSOR_SHA,
        predecessorDigest: PREDECESSOR_DIGEST,
      });
    });
  });

  describe('durable transaction state', () => {
    it('records null predecessor identity and an explicit first-install marker', () => {
      const root = temporaryRoot();
      const result = sourced([
        ...harnessPreamble(root),
        'resolve_predecessor',
        'write_state prepared running "first install"',
      ], {
        argv: stageArguments(['', '']),
        environment: firstInstallEnvironment(root),
      });

      expect(result.status, result.stderr).toBe(0);
      const state = JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8'));
      expect(state).toMatchObject({
        schema: 'nexus.lean-release-transaction.v1',
        role: 'staging',
        firstInstall: true,
        predecessor: null,
        predecessorSha: null,
        predecessorDigest: null,
        phase: 'prepared',
        status: 'running',
      });
      expect(state.checks.rollbackReadiness).toBe('not_applicable');
      // The receipt must never be mistakable for a normally staged release.
      expect(state.checks.rollbackReadiness).not.toBe('passed');
      // The first-install marker is the last of write_state's 32 positional
      // arguments. Pinning the fields on either side of it keeps a future
      // argument insertion from silently shifting every value one slot.
      expect(state).toMatchObject({
        stabilitySeconds: 15,
        candidateHealthBudgetSeconds: 45,
        rollbackHealthBudgetSeconds: 45,
        rollbackObjectiveSeconds: 120,
        faultInjection: null,
        candidateRemoved: false,
      });
    });

    it('fails closed with durable state when a first install fails after mutation', () => {
      const root = temporaryRoot();
      const result = sourced([
        ...harnessPreamble(root),
        'resolve_predecessor',
        'ROLLBACK_ARMED=true',
        'MUTATED=true',
        'set +e',
        '( exit 7 )',
        'on_exit',
      ], {
        argv: stageArguments(['', '']),
        environment: firstInstallEnvironment(root),
      });

      expect(result.status).toBe(7);
      const state = JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8'));
      expect(state).toMatchObject({
        firstInstall: true,
        phase: 'first_install_failed',
        status: 'failed',
        healthResult: 'failed',
        rollbackResult: 'unavailable',
        predecessor: null,
        predecessorSha: null,
        predecessorDigest: null,
      });
      // The receipt is the only thing an operator has after a first install
      // strands the host, so it must name the recovery runbook itself.
      expect(state.message).toContain(
        'first install failed after runtime mutation and has no predecessor to restore',
      );
      expect(state.message).toContain('Recovering a failed first install');
      expect(state.message).toContain('docs/release/README.md');
      // It must never borrow the pre-mutation wording that the operator treats
      // as a safe, non-mutating abort.
      expect(state.message).not.toBe('transaction stopped before runtime mutation');
      expect(state.phase).not.toBe('rolled_back');
    });

    it('keeps the unmutated failure receipt unchanged for a first install', () => {
      const root = temporaryRoot();
      const result = sourced([
        ...harnessPreamble(root),
        'resolve_predecessor',
        'PHASE=preparing',
        'set +e',
        '( exit 5 )',
        'on_exit',
      ], {
        argv: stageArguments(['', '']),
        environment: firstInstallEnvironment(root),
      });

      expect(result.status).toBe(5);
      const state = JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8'));
      expect(state).toMatchObject({
        firstInstall: true,
        phase: 'preparing',
        status: 'failed',
        message: 'transaction stopped before runtime mutation',
      });
    });

    it('keeps a normal staged receipt free of the first-install marker', () => {
      const root = temporaryRoot();
      const result = sourced([
        ...harnessPreamble(root),
        'PREDECESSOR="$BASE_DIR/releases/predecessor"',
        `PREDECESSOR_SHA=${JSON.stringify(PREDECESSOR_SHA)}`,
        `PREDECESSOR_DIGEST=${JSON.stringify(PREDECESSOR_DIGEST)}`,
        'ROLLBACK_READINESS=passed',
        'write_state prepared running',
      ]);

      expect(result.status, result.stderr).toBe(0);
      const state = JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8'));
      expect(state).toMatchObject({
        firstInstall: false,
        predecessorSha: PREDECESSOR_SHA,
        predecessorDigest: PREDECESSOR_DIGEST,
      });
      expect(state.checks.rollbackReadiness).toBe('passed');
    });
  });

  // A first install that SUCCEEDS is the other half of the problem. Its receipt
  // has no predecessor and rollbackReadiness `not_applicable`, so it can never be
  // promoted; if `prepare` also reads it as "this artifact is already staged",
  // the host is wedged after a successful bootstrap with no way forward.
  describe('the operator has a path forward after a successful first install', () => {
    // The embedded classifiers are extracted and executed rather than restated,
    // so these assertions run the exact code release-operator.sh runs.
    function embeddedProgram(open: string, close: string): string {
      const operator = fs.readFileSync(OPERATOR, 'utf8');
      const start = operator.indexOf(open);
      expect(start, `classifier opening not found: ${open}`).toBeGreaterThan(-1);
      const end = operator.indexOf(close, start + open.length);
      expect(end, `classifier close not found: ${close}`).toBeGreaterThan(-1);
      return `${operator.slice(start + open.length, end)}});`;
    }

    function runClassifier(program: string, receipt: unknown): SpawnSyncReturns<string> {
      return spawnSync(process.execPath, ['-e', program, RUNTIME_SHA, ARTIFACT_DIGEST], {
        encoding: 'utf8',
        input: JSON.stringify(receipt),
      });
    }

    const RESUME = () => embeddedProgram(
      'RESUME_TRANSACTION_ID="$(printf \'%s\' "$REMOTE_STAGING_STATE" | node -e \'',
      '});\' "$RUNTIME_SHA" "$ARTIFACT_DIGEST")"',
    );
    const PREDECESSOR_IDENTITY = () => embeddedProgram(
      'STAGING_PREDECESSOR_IDENTITY="$(\n        printf \'%s\' "$REMOTE_STAGING_STATE" | node -e \'',
      '});\'\n      )"',
    );

    function receipt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
      return {
        schema: 'nexus.lean-release-transaction.v1',
        role: 'staging',
        transactionId: TRANSACTION_ID,
        runtimeSha: RUNTIME_SHA,
        artifactDigest: ARTIFACT_DIGEST,
        firstInstall: false,
        predecessor: `${STAGING_BASE}/releases/previous`,
        predecessorSha: PREDECESSOR_SHA,
        predecessorDigest: PREDECESSOR_DIGEST,
        phase: 'completed',
        status: 'passed',
        message: null,
        healthResult: 'passed',
        rollbackResult: 'not_required',
        rollbackDurationMs: null,
        rollbackObjectiveSeconds: 120,
        faultInjection: null,
        candidateRemoved: false,
        ...overrides,
      };
    }

    function firstInstallReceipt(
      overrides: Record<string, unknown> = {},
    ): Record<string, unknown> {
      return receipt({
        firstInstall: true,
        predecessor: null,
        predecessorSha: null,
        predecessorDigest: null,
        ...overrides,
      });
    }

    it('still treats a normal completed staging receipt as already staged', () => {
      const result = runClassifier(RESUME(), receipt());

      expect(result.status).toBe(0);
      expect(result.stdout).toBe(TRANSACTION_ID);
    });

    it('does not treat a completed first install as already staged', () => {
      const result = runClassifier(RESUME(), firstInstallReceipt());

      // A distinct code, because the answer is neither "resume this" nor "this
      // failed": the artifact is installed, but its receipt is not promotable.
      expect(result.status).toBe(6);
      expect(result.status).not.toBe(0);
    });

    it('names the next step instead of silently reporting the artifact staged', () => {
      const operator = fs.readFileSync(OPERATOR, 'utf8');

      expect(operator).toContain('first-install bootstrap');
      expect(operator).toContain('not promotable');
      expect(operator).toContain('docs/release/README.md');
    });

    it('keeps a failed first install in the inspect-before-retry class', () => {
      for (const phase of ['first_install_failed', 'first_install_aborted']) {
        const result = runClassifier(RESUME(), firstInstallReceipt({
          phase,
          status: 'failed',
          healthResult: phase === 'first_install_failed' ? 'failed' : 'pending',
          rollbackResult: phase === 'first_install_failed' ? 'unavailable' : null,
          message: 'first install stopped',
        }));

        expect(result.status, phase).toBe(2);
      }
    });

    it('keeps every other resume class unchanged', () => {
      expect(runClassifier(RESUME(), receipt({ status: 'running', phase: 'health' })).status)
        .toBe(4);
      expect(runClassifier(RESUME(), receipt({
        status: 'failed',
        phase: 'preparing',
        healthResult: 'pending',
        rollbackResult: null,
        message: 'transaction stopped before runtime mutation',
      })).status).toBe(5);
      expect(runClassifier(RESUME(), receipt({ runtimeSha: 'f'.repeat(40) })).status).toBe(3);
    });

    // The bootstrapped release is a perfectly good predecessor for whatever is
    // staged next. That is the path forward, and it must keep working.
    it('reads the bootstrapped artifact as the predecessor for the next release', () => {
      const result = runClassifier(PREDECESSOR_IDENTITY(), firstInstallReceipt());

      expect(result.status).toBe(0);
      expect(result.stdout).toBe(`${RUNTIME_SHA} ${ARTIFACT_DIGEST}`);
    });
  });

  describe('operator plumbing', () => {
    function runOperator(
      argv: string[],
      environment: NodeJS.ProcessEnv = {},
    ): SpawnSyncReturns<string> {
      return spawnSync('bash', [OPERATOR, ...argv], {
        cwd: process.cwd(),
        encoding: 'utf8',
        timeout: 60_000,
        env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...environment },
      });
    }

    it('rejects a first install request on the promote command', () => {
      const result = runOperator(['promote', '--first-install'], {
        NEXUS_RELEASE_OWNER_AUTHORIZED: '1',
      });

      expect(result.status).toBe(64);
      expect(result.stderr).toContain('--first-install is valid only for prepare');
    });

    it('requires explicit owner authorization for a first install', () => {
      const result = runOperator(['prepare', '--first-install']);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        'first install requires NEXUS_RELEASE_OWNER_AUTHORIZED=1',
      );
    });

    it('refuses to combine a first install with the staging fault drill', () => {
      const result = runOperator(['prepare', '--first-install', '--staging-fault-after-switch'], {
        NEXUS_RELEASE_OWNER_AUTHORIZED: '1',
        NEXUS_RELEASE_DRILL_AUTHORIZED: '1',
      });

      expect(result.status).toBe(64);
      expect(result.stderr).toContain(
        '--first-install cannot be combined with the staging fault drill',
      );
    });
  });

  it('documents a concrete recovery for a first install that failed after mutation', () => {
    const readme = fs.readFileSync('docs/release/README.md', 'utf8');
    const section = readme.slice(readme.indexOf('#### Recovering a failed first install'));

    expect(readme).toContain('#### Recovering a failed first install');
    expect(section).not.toBe('');
    // The stranded host has no predecessor, so recovery is returning it to the
    // virgin shape the guard will accept again. Every signal the guard now
    // refuses on has to be named, or the retry refuses and the runbook is wrong.
    expect(section).toContain('pm2 delete nexus-hub-staging content-engine-staging');
    expect(section).toContain('pm2 save --force');
    expect(section).toContain('rm -f /home/dominguez/telegram-hub-bot-staging/current');
    expect(section).toContain('/home/dominguez/telegram-hub-bot-staging/releases/');
    expect(section).toContain('/home/dominguez/.local/state/nexus-release/staging.json');
    // Recovery must never touch the persistent data the release path preserves.
    expect(section).toContain('data/');
    expect(section).not.toMatch(/rm -rf [^\n]*telegram-hub-bot-staging\/data/);
    expect(section).not.toMatch(/rm -rf [^\n]*telegram-hub-bot-staging\/\.env/);
  });

  it('documents the real sequence that follows a successful first install', () => {
    const readme = fs.readFileSync('docs/release/README.md', 'utf8');
    const section = readme.slice(readme.indexOf('#### After a successful first install'));

    expect(readme).toContain('#### After a successful first install');
    expect(section).not.toBe('');
    // The bootstrap receipt is not promotable, and re-preparing the same exact
    // artifact cannot make it promotable: that release is already installed.
    expect(section).toContain('not promotable');
    expect(section).toContain('npm run release:prepare');
    expect(section).toContain('npm run release:promote');
    expect(section).toMatch(/next release|next artifact|subsequent release/);
  });

  it('gates promotion on a staging receipt that has a real predecessor', () => {
    const operator = fs.readFileSync(OPERATOR, 'utf8');
    const promote = operator.slice(operator.indexOf('\n  promote)'));

    expect(promote).toContain('--role staging');
    expect(promote).toContain('--require-promotable');
  });

  it('keeps both release shell scripts syntactically valid', () => {
    for (const script of [TRANSACTION, OPERATOR, path.resolve('scripts/promote-exact-release.sh')]) {
      const result = spawnSync('bash', ['-n', script], { encoding: 'utf8' });
      expect(result.status, `${script}: ${result.stderr}`).toBe(0);
    }
  });
});
