import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { OCI_DIGEST, fail } from './release-canonical.mjs';
import { createReleaseEnvironmentGate } from './release-environment.mjs';

/**
 * Registry and Compose access for the deployment host.
 *
 * Every command goes through an injected `exec`, which is what lets the
 * deployment tests drive staging failures, observation failures, rollback and
 * rollback-failure paths without a Docker daemon. The real `exec` is the only
 * part of this module that is not exercised by unit tests.
 *
 * The release payload — the signed manifest and the Compose file — is shipped as
 * its own tiny OCI image rather than fetched over the registry HTTP API. That
 * keeps the host's dependency surface at exactly `docker`, and the payload is
 * still digest- and signature-verified before anything is trusted.
 */

export const RELEASE_PAYLOAD_MANIFEST_PATH = '/release/release-manifest.json';
export const RELEASE_PAYLOAD_COMPOSE_PATH = '/release/docker-compose.release.yml';

export function releaseChildEnvironment(source = process.env) {
  const allowed = {};
  for (const name of ['PATH', 'HOME', 'DOCKER_CONFIG']) {
    if (typeof source?.[name] === 'string' && source[name] !== '') {
      allowed[name] = source[name];
    }
  }
  return allowed;
}

export function defaultExec(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 300_000,
    maxBuffer: 8 * 1024 * 1024,
    env: options.env ?? releaseChildEnvironment(),
    cwd: options.cwd,
    input: options.input,
  });
  return {
    status: result.error ? 127 : (result.status ?? 1),
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? (result.error ? String(result.error.message) : ''),
  };
}

function defaultSleep(milliseconds) {
  const signal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  Atomics.wait(signal, 0, 0, milliseconds);
}

export function createReleaseRegistry({
  policy,
  exec = defaultExec,
  dockerBin = process.env.NEXUS_RELEASE_DOCKER_BIN || 'docker',
  environmentGate = createReleaseEnvironmentGate({ policy }),
  sleep = defaultSleep,
}) {
  function docker(args, options = {}) {
    const result = exec(dockerBin, args, options);
    if (result.status !== 0 && !options.allowFailure) {
      fail(`docker ${args[0] ?? ''} failed with status ${result.status}`);
    }
    return result;
  }

  function pull(reference, { timeoutMs } = {}) {
    return docker(['pull', '--quiet', reference], { timeoutMs });
  }

  /**
   * Resolve the immutable digest of a reference that may be a moving tag. The
   * digest is what the signature binds, so a tag is only ever used to discover
   * a digest, never to deploy one.
   */
  function resolveDigest(reference) {
    const result = docker([
      'image', 'inspect', '--format', '{{join .RepoDigests "\\n"}}', reference,
    ]);
    const digests = result.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
    for (const entry of digests) {
      const at = entry.lastIndexOf('@');
      if (at === -1) continue;
      const digest = entry.slice(at + 1);
      if (OCI_DIGEST.test(digest)) return digest;
    }
    return fail(`could not resolve an immutable digest for ${reference}`);
  }

  function imageExistsLocally(reference) {
    const result = docker(['image', 'inspect', '--format', '{{.Id}}', reference], {
      allowFailure: true,
    });
    return result.status === 0;
  }

  /**
   * Copy the release payload out of the pointer image. `docker create` makes a
   * container without running it, so nothing from the payload image executes.
   */
  function extractReleasePayload({ reference, destinationDir, timeoutMs }) {
    fs.mkdirSync(destinationDir, { recursive: true, mode: 0o700 });
    // Extraction is several Docker commands, but rollback supplies one remaining
    // objective budget for the whole operation. Recompute the remaining wall time
    // before each command instead of accidentally granting every command the full
    // budget independently.
    const deadline = Number.isFinite(timeoutMs)
      ? Date.now() + Math.max(0, timeoutMs)
      : null;
    const commandOptions = (extra = {}) => ({
      ...extra,
      ...(deadline === null ? {} : { timeoutMs: Math.max(1, deadline - Date.now()) }),
    });
    const created = docker(
      ['create', '--pull', 'never', reference],
      commandOptions(),
    );
    const containerId = created.stdout.trim().split('\n').pop()?.trim() ?? '';
    if (!/^[0-9a-f]{12,64}$/.test(containerId)) {
      fail('docker create did not return a container id for the release payload');
    }
    try {
      const manifestPath = path.join(destinationDir, 'release-manifest.json');
      const composePath = path.join(destinationDir, 'docker-compose.release.yml');
      docker(
        ['cp', `${containerId}:${RELEASE_PAYLOAD_MANIFEST_PATH}`, manifestPath],
        commandOptions(),
      );
      docker(
        ['cp', `${containerId}:${RELEASE_PAYLOAD_COMPOSE_PATH}`, composePath],
        commandOptions(),
      );
      return {
        manifestBytes: fs.readFileSync(manifestPath),
        composeBytes: fs.readFileSync(composePath),
        composePath,
        payloadDir: destinationDir,
      };
    } finally {
      docker(['rm', '--force', containerId], commandOptions({ allowFailure: true }));
    }
  }

  function requireComposeReleaseIdentity(releaseIdentity, images) {
    if (!releaseIdentity || typeof releaseIdentity !== 'object' || Array.isArray(releaseIdentity)
        || Object.keys(releaseIdentity).sort().join(',')
          !== 'backendImageDigest,releaseId,sourceSha'
        || !/^[0-9a-f]{32}$/.test(releaseIdentity.releaseId ?? '')
        || !/^[0-9a-f]{40}$/.test(releaseIdentity.sourceSha ?? '')
        || !OCI_DIGEST.test(releaseIdentity.backendImageDigest ?? '')
        || releaseIdentity.backendImageDigest !== images?.backend?.digest) {
      fail('Compose release identity must exactly match the selected backend image');
    }
    return releaseIdentity;
  }

  function requireRuntimePlanDir(planDir) {
    const workRoot = policy.paths.workDir;
    if (typeof planDir !== 'string'
        || !path.isAbsolute(planDir)
        || path.normalize(planDir) !== planDir
        || path.basename(planDir) !== 'runtime-plan') {
      fail('Compose runtime plan directory is absent or malformed');
    }
    const payloadDir = path.dirname(planDir);
    if (path.dirname(payloadDir) !== workRoot
        || !/^[0-9a-f]{64}$/.test(path.basename(payloadDir))) {
      fail('Compose runtime plan directory is outside the governed payload root');
    }

    let payloadStat;
    let planStat;
    let planFileStat;
    const planPath = path.join(planDir, 'migration-plan.json');
    try {
      payloadStat = fs.lstatSync(payloadDir);
      planStat = fs.lstatSync(planDir);
      planFileStat = fs.lstatSync(planPath);
    } catch {
      fail('Compose runtime plan directory or plan is absent');
    }
    if (!payloadStat.isDirectory() || payloadStat.isSymbolicLink()
        || fs.realpathSync(payloadDir) !== payloadDir
        || !planStat.isDirectory() || planStat.isSymbolicLink()
        || fs.realpathSync(planDir) !== planDir
        || (planStat.mode & 0o777) !== 0o755) {
      fail('Compose runtime plan directory is unsafe');
    }
    if (!planFileStat.isFile() || planFileStat.isSymbolicLink()
        || planFileStat.nlink !== 1
        || (planFileStat.mode & 0o777) !== 0o644
        || planFileStat.size < 2 || planFileStat.size > 1024 * 1024
        || fs.realpathSync(planPath) !== planPath) {
      fail('Compose runtime migration plan is unsafe');
    }
    return planDir;
  }

  function composeProcessBaseEnvironment() {
    // Compose receives no ambient systemd/poller/operator variables. In
    // particular, DOCKER_HOST/DOCKER_CONTEXT, COMPOSE_FILE/PROFILES/ENV_FILES,
    // NODE_OPTIONS, loader hooks, Git configuration and notification secrets
    // cannot redirect or influence a render. These three process paths are
    // pinned by the installed unit; every topology input is added explicitly
    // below from verified policy/manifest state.
    return {
      ...releaseChildEnvironment(),
      // Never load a checkout/work-directory `.env` as a second interpolation
      // authority. Service env files are still supplied by explicit absolute
      // paths in the governed Compose topology.
      COMPOSE_DISABLE_ENV_FILE: '1',
    };
  }

  function composeEnv({
    environment, images, releaseIdentity: identityInput, composeProject, planDir,
  }) {
    const target = policy.environments[environment];
    if (!target) fail(`unknown release environment ${environment}`);
    const releaseIdentity = requireComposeReleaseIdentity(identityInput, images);
    const runtimePlanDir = requireRuntimePlanDir(planDir);
    if (!environmentGate || typeof environmentGate.verify !== 'function') {
      fail('release environment gate is not configured');
    }
    const environmentProof = environmentGate.verify(environment);
    const ollamaGatewaySocketDir = `/run/nexus-inference/${environment}`;
    return {
      ...composeProcessBaseEnvironment(),
      // Read-only mount holding the signed migration plan the migrator enforces.
      NEXUS_RELEASE_PLAN_DIR: runtimePlanDir,
      COMPOSE_PROJECT_NAME: composeProject ?? target.composeProject,
      NEXUS_BACKEND_IMAGE: `${images.backend.repository}@${images.backend.digest}`,
      NEXUS_CONTENT_ENGINE_IMAGE:
        `${images.contentEngine.repository}@${images.contentEngine.digest}`,
      NEXUS_RELEASE_ID: releaseIdentity.releaseId,
      NEXUS_RELEASE_SOURCE_SHA: releaseIdentity.sourceSha,
      NEXUS_RELEASE_BACKEND_DIGEST: releaseIdentity.backendImageDigest,
      NEXUS_RELEASE_ENVIRONMENT: environment,
      NEXUS_BACKEND_ENV_FILE: target.backendEnvFile,
      NEXUS_CONTENT_ENGINE_ENV_FILE: target.contentEngineEnvFile,
      NEXUS_APP_STAGING: environment === 'staging' ? 'true' : 'false',
      // The root host gate descriptor-reads and validates a configured APNs
      // key before converting it to the escaped single-line form accepted by
      // the application. A host-only path must never reach the container.
      NEXUS_APNS_AUTH_KEY_P8_ESCAPED: environmentProof.apnsAuthKeyEscaped,
      NEXUS_DATA_DIR: target.dataDir,
      NEXUS_BACKEND_PORT: String(target.backendPort),
      NEXUS_CONTENT_ENGINE_PORT: String(target.contentEnginePort),
      // The root-owned socket transaction creates these exact per-environment
      // directories before a topology containing the gateway may be released.
      // Derive both values from the closed environment selector rather than a
      // mutable env file so staging and production can never share a socket.
      NEXUS_OLLAMA_GATEWAY_SOCKET_DIR: ollamaGatewaySocketDir,
      NEXUS_OLLAMA_GATEWAY_SOCKET_PATH: `${ollamaGatewaySocketDir}/ollama.sock`,
    };
  }

  function composeArgs(composeFile, rest) {
    return ['compose', '--file', composeFile, ...rest];
  }

  function composeConfigValid({
    composeFile, environment, images, releaseIdentity, planDir,
  }) {
    const result = docker(composeArgs(composeFile, ['config', '--quiet']), {
      env: composeEnv({ environment, images, releaseIdentity, planDir }),
      allowFailure: true,
    });
    return { ok: result.status === 0, status: result.status };
  }

  function composeUp({
    composeFile, environment, images, releaseIdentity, planDir, timeoutMs,
  }) {
    return docker(
      composeArgs(composeFile, ['up', '--detach', '--wait', '--remove-orphans']),
      {
        env: composeEnv({ environment, images, releaseIdentity, planDir }),
        timeoutMs,
        allowFailure: true,
      },
    );
  }

  function composeDown({ composeFile, environment, images, releaseIdentity, planDir }) {
    const target = policy.environments[environment];
    if (!target) fail(`unknown release environment ${environment}`);
    let result;
    try {
      result = docker(composeArgs(composeFile, ['down', '--remove-orphans']), {
        env: composeEnv({ environment, images, releaseIdentity, planDir }),
        allowFailure: true,
      });
    } catch {
      // Teardown is also the recovery path for an accepted pre-production
      // release. If its full runtime environment can no longer be rendered,
      // the exact project-label census below is still sufficient to prove that
      // no governed staging resource exists. Present or unreadable resources
      // continue to fail closed.
      result = { status: 1, stdout: '', stderr: '' };
    }
    if (result.status === 0) return result;

    // `docker compose down` can return non-zero while its last network removal
    // is settling. Treat that result as a no-op only after a bounded proof that
    // both kinds of resources owned by this exact governed project are absent.
    // A partial stack, an unknown project, or an uninspectable Docker daemon
    // remains a teardown failure for the deployment layer to block.
    const projectLabel = `label=com.docker.compose.project=${target.composeProject}`;
    const settleStartedAt = Date.now();
    const proof = (classification, attempts) => ({
      teardownProof: {
        classification,
        attempts,
        elapsedMs: Math.max(0, Date.now() - settleStartedAt),
      },
    });
    // Docker can keep the last network object visible briefly after Compose
    // has detached its containers. Give that daemon transition a bounded
    // thirty-second settle window, while still failing closed for any
    // persistent or unreadable resource.
    const settleAttempts = 61;
    for (let attempt = 0; attempt < settleAttempts; attempt += 1) {
      const containers = docker([
        'container', 'ls', '--all', '--filter', projectLabel, '--format', '{{.ID}}',
      ], { allowFailure: true });
      if (containers.status !== 0) {
        return { ...result, ...proof('container_enumeration_failed', attempt + 1) };
      }
      if (containers.stdout.trim() !== '') {
        return { ...result, ...proof('container_present', attempt + 1) };
      }
      const networks = docker([
        'network', 'ls', '--filter', projectLabel, '--format', '{{.ID}}',
      ], { allowFailure: true });
      if (networks.status !== 0) {
        return { ...result, ...proof('network_enumeration_failed', attempt + 1) };
      }
      if (containers.stdout.trim() === '' && networks.stdout.trim() === '') {
        return {
          ...result,
          status: 0,
          alreadyAbsent: true,
          ...proof('absent_after_attempts', attempt + 1),
        };
      }
      if (attempt < settleAttempts - 1) sleep(500);
    }

    return { ...result, ...proof('network_present_timeout', settleAttempts) };
  }

  function composeRunMigrator({
    composeFile, environment, images, releaseIdentity, planDir, timeoutMs,
  }) {
    return docker(
      composeArgs(composeFile, ['--profile', 'migrate', 'run', '--rm', 'migrator']),
      {
        env: composeEnv({ environment, images, releaseIdentity, planDir }),
        timeoutMs,
        allowFailure: true,
      },
    );
  }

  function composeServiceHealth({
    composeFile, environment, images, releaseIdentity, planDir, service, timeoutMs,
  }) {
    const result = docker(
      composeArgs(composeFile, ['ps', '--format', 'json', service]),
      {
        env: composeEnv({ environment, images, releaseIdentity, planDir }),
        timeoutMs,
        allowFailure: true,
      },
    );
    if (result.status !== 0) return { healthy: false, state: 'unknown', image: null };
    const lines = result.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
    for (const line of lines) {
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const entries = Array.isArray(parsed) ? parsed : [parsed];
      for (const entry of entries) {
        // Require the shape, not just the fields we want to read. `{"Health":
        // "healthy"}` used to be accepted as proof a named service was up, so a
        // truncated or unrelated JSON object could stand in for a real container.
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
        if (typeof entry.Service !== 'string' || entry.Service !== service) continue;
        if (typeof entry.Name !== 'string' || entry.Name.length === 0) continue;
        if (typeof entry.State !== 'string' || entry.State.length === 0) continue;
        const health = typeof entry.Health === 'string' ? entry.Health.toLowerCase() : '';
        const state = entry.State.toLowerCase();
        const image = typeof entry.Image === 'string' ? entry.Image : null;
        // A container with a healthcheck must report `healthy`. Only a service
        // with no healthcheck at all may fall back to `running`.
        const healthy = health === 'healthy' || (health === '' && state === 'running');
        return { healthy, state: health || state, image, name: entry.Name };
      }
    }
    return { healthy: false, state: 'absent', image: null };
  }

  /**
   * Confirm the containers actually running are the ones the release intends.
   *
   * A rollback that reports success without this can be wrong in the worst way:
   * the failed candidate stays up, health passes because the candidate is
   * healthy, and the receipt records the predecessor as restored.
   */
  function composeRunningImages({
    composeFile, environment, images, releaseIdentity, planDir, services, timeoutMs,
  }) {
    const observed = {};
    // As with payload extraction, two service queries share one caller budget.
    // The second query receives only the time the first left behind.
    const deadline = Number.isFinite(timeoutMs)
      ? Date.now() + Math.max(0, timeoutMs)
      : null;
    for (const service of services) {
      const health = composeServiceHealth({
        composeFile,
        environment,
        images,
        releaseIdentity,
        planDir,
        service,
        timeoutMs: deadline === null ? undefined : Math.max(1, deadline - Date.now()),
      });
      observed[service] = health;
    }
    return observed;
  }

  function imageMatchesDigest(observedImage, repository, digest) {
    if (typeof observedImage !== 'string' || observedImage.length === 0) return false;
    // Compose reports either repo@sha256:... or a resolved digest reference.
    if (observedImage === `${repository}@${digest}`) return true;
    return observedImage.endsWith(`@${digest}`);
  }

  /**
   * Keep exactly the current and immediate-predecessor digests for each image
   * repository. Unbounded local images fill the host disk, and a host that
   * cannot write is a host that cannot roll back.
   */
  function pruneImages({ repository, keepDigests }) {
    const keep = new Set(keepDigests.filter(Boolean));
    const limit = Number(policy.registry.retainedImagePairs);
    const retained = new Set(keep);
    const listed = docker([
      'image', 'list', '--no-trunc', '--format', '{{.Digest}}', repository,
    ], { allowFailure: true });
    if (listed.status !== 0) return { removed: [], kept: [...retained] };
    const removed = [];
    const seen = new Set();
    for (const line of listed.stdout.split('\n')) {
      const digest = line.trim();
      if (!OCI_DIGEST.test(digest) || seen.has(digest)) continue;
      seen.add(digest);
      if (keep.has(digest)) continue;
      if (retained.size < limit) {
        retained.add(digest);
        continue;
      }
      const result = docker(['image', 'remove', `${repository}@${digest}`], {
        allowFailure: true,
      });
      if (result.status === 0) removed.push(digest);
    }
    return { removed, kept: [...retained] };
  }

  /**
   * Bound the extracted release payload directories.
   *
   * Every poll that sees a new pointer extracts a payload into its own directory.
   * Unbounded, that fills the host disk, and a host that cannot write is a host
   * that cannot roll back or record a receipt.
   */
  function pruneWorkDirs({ keepDirs }) {
    const workRoot = policy.paths.workDir;
    const keep = new Set(keepDirs.filter(Boolean).map((dir) => path.basename(dir)));
    const limit = Number(policy.retention?.workDirs ?? 5);
    let entries;
    try {
      entries = fs.readdirSync(workRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && /^[0-9a-f]{64}$/.test(entry.name))
        .map((entry) => entry.name)
        .sort();
    } catch {
      return { removed: [] };
    }
    // Newest last by name is not meaningful for digests, so order by mtime.
    const byRecency = entries
      .map((name) => {
        let mtimeMs = 0;
        try {
          mtimeMs = fs.statSync(path.join(workRoot, name)).mtimeMs;
        } catch {
          mtimeMs = 0;
        }
        return { name, mtimeMs };
      })
      .sort((left, right) => right.mtimeMs - left.mtimeMs);

    const protectedCount = byRecency.filter((entry) => keep.has(entry.name)).length;
    const unprotectedSlots = Math.max(0, limit - protectedCount);
    const removed = [];
    let retainedUnprotected = 0;
    for (const entry of byRecency) {
      if (keep.has(entry.name)) continue;
      if (retainedUnprotected < unprotectedSlots) {
        retainedUnprotected += 1;
        continue;
      }
      try {
        fs.rmSync(path.join(workRoot, entry.name), { recursive: true, force: true });
        removed.push(entry.name);
      } catch {
        // a payload we cannot remove is not fatal; the next poll retries
      }
    }
    return { removed };
  }

  return {
    pull,
    resolveDigest,
    pruneWorkDirs,
    imageExistsLocally,
    extractReleasePayload,
    composeEnv,
    composeConfigValid,
    composeUp,
    composeDown,
    composeRunMigrator,
    composeServiceHealth,
    composeRunningImages,
    imageMatchesDigest,
    pruneImages,
  };
}
