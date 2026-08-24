const RELEASE_ID = /^[0-9a-f]{32}$/u;

export const RELEASE_DEPLOY_BOOTSTRAP_FLAG = '--allow-first-container-bootstrap';
export const RELEASE_DEPLOY_GOVERNANCE_FLAG = '--authorize-governance-only';

export class ReleaseDeployArgumentError extends Error {
  constructor(message, exitCode) {
    super(message);
    this.exitCode = exitCode;
  }
}

export function parseReleaseDeployArguments({ argv, env }) {
  const bootstrapCount = argv.filter(
    (argument) => argument === RELEASE_DEPLOY_BOOTSTRAP_FLAG,
  ).length;
  const governanceIndex = argv.indexOf(RELEASE_DEPLOY_GOVERNANCE_FLAG);
  const governanceCount = argv.filter(
    (argument) => argument === RELEASE_DEPLOY_GOVERNANCE_FLAG,
  ).length;
  const governanceOnlyReleaseId = governanceIndex >= 0 ? argv[governanceIndex + 1] : null;
  const expectedArgCount = bootstrapCount + (governanceCount > 0 ? 2 : 0);
  if (bootstrapCount > 1
      || governanceCount > 1
      || argv.length !== expectedArgCount
      || (governanceCount === 1 && !RELEASE_ID.test(governanceOnlyReleaseId ?? ''))
      || (bootstrapCount === 1 && governanceCount === 1)) {
    throw new ReleaseDeployArgumentError(
      `supported arguments are ${RELEASE_DEPLOY_BOOTSTRAP_FLAG} or `
      + `${RELEASE_DEPLOY_GOVERNANCE_FLAG} <releaseId>`,
      64,
    );
  }
  const ownerAuthorized = env.NEXUS_RELEASE_OWNER_AUTHORIZED === '1';
  if (governanceOnlyReleaseId !== null && !ownerAuthorized) {
    throw new ReleaseDeployArgumentError(
      `${RELEASE_DEPLOY_GOVERNANCE_FLAG} requires `
      + 'NEXUS_RELEASE_OWNER_AUTHORIZED=1 on this one process',
      77,
    );
  }
  return {
    allowFirstContainerBootstrap: bootstrapCount === 1,
    governanceOnlyReleaseId,
    ownerAuthorized,
  };
}
