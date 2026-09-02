import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { fail } from './release-canonical.mjs';

const FULL_SHA = /^[0-9a-f]{40}$/;
const MAX_HEAD_OUTPUT_BYTES = 4 * 1024;

export const PROTECTED_HEAD_RESULTS = Object.freeze({
  CURRENT: 'current',
  MISMATCH: 'mismatch',
  UNAVAILABLE: 'unavailable',
});

function defaultExec(command, args, options) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: options.timeoutMs,
    maxBuffer: MAX_HEAD_OUTPUT_BYTES,
    env: options.env,
  });
  return {
    status: result.error ? null : result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/**
 * Resolve the exact public protected-ref head without GitHub or registry
 * credentials. Git configuration, credential helpers, prompts, user HOME and
 * caller-provided headers are deliberately excluded from this subprocess.
 */
export function createProtectedHeadVerifier({
  policy,
  exec = defaultExec,
  gitBin = process.env.NEXUS_RELEASE_GIT_BIN || '/usr/bin/git',
}) {
  if (typeof gitBin !== 'string'
      || !path.isAbsolute(gitBin)
      || path.normalize(gitBin) !== gitBin) {
    fail('protected-head Git binary must be a normalized absolute path');
  }

  const repositoryUrl = policy.trust.protectedRepositoryUrl;
  const protectedRef = policy.trust.protectedRef;
  const timeoutMs = policy.timing.protectedHeadTimeoutSeconds * 1000;
  const scrubbedEnvironment = Object.freeze({
    PATH: '/usr/bin:/bin',
    HOME: '/var/empty',
    XDG_CONFIG_HOME: '/var/empty',
    LANG: 'C',
    LC_ALL: 'C',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '/bin/false',
    SSH_ASKPASS: '/bin/false',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
  });

  function verify({ expectedSha }) {
    if (typeof expectedSha !== 'string' || !FULL_SHA.test(expectedSha)) {
      fail('protected-head verification requires a full lowercase source SHA');
    }

    const result = exec(gitBin, [
      // GitHub's smart-HTTP protocol-v2 flow can advertise anonymously and
      // then reject the follow-up ls-refs request. Protocol v0 resolves the
      // same exact public ref in one credential-free request, avoiding a
      // false protected-head outage while preserving the scrubbed envelope.
      '-c', 'protocol.version=0',
      '-c', 'credential.helper=',
      '-c', 'core.askPass=/bin/false',
      '-c', 'http.extraHeader=',
      'ls-remote', '--exit-code', '--refs', repositoryUrl, protectedRef,
    ], {
      timeoutMs,
      env: scrubbedEnvironment,
    });
    if (result.status !== 0
        || Buffer.byteLength(result.stdout, 'utf8') > MAX_HEAD_OUTPUT_BYTES
        || Buffer.byteLength(result.stderr, 'utf8') > MAX_HEAD_OUTPUT_BYTES) {
      return { result: PROTECTED_HEAD_RESULTS.UNAVAILABLE, expectedSha, headSha: null };
    }

    const lines = result.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
    if (lines.length !== 1) {
      return { result: PROTECTED_HEAD_RESULTS.UNAVAILABLE, expectedSha, headSha: null };
    }
    const match = lines[0].match(/^([0-9a-f]{40})\t(refs\/heads\/[A-Za-z0-9._/-]+)$/);
    if (!match || match[2] !== protectedRef) {
      return { result: PROTECTED_HEAD_RESULTS.UNAVAILABLE, expectedSha, headSha: null };
    }
    const headSha = match[1];
    return {
      result: headSha === expectedSha
        ? PROTECTED_HEAD_RESULTS.CURRENT
        : PROTECTED_HEAD_RESULTS.MISMATCH,
      expectedSha,
      headSha,
    };
  }

  return { verify };
}
