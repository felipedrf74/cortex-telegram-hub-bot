const LEGACY_SCHEMA = 'nexus.release-state.v1';
const HOST_VIEW_SCHEMA = 'nexus.release-state-view.v2';
const HOST_STATE_SCHEMA = 'nexus.release-host-state.v1';
const RECEIPT_SCHEMA = 'nexus.release-receipt.v3';

function canonicalTimestamp(value) {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value));
}
function hasOwn(value, key) {
  return value !== null
    && typeof value === 'object'
    && Object.prototype.hasOwnProperty.call(value, key);
}

function legacySummaryIssues(state, releaseSummary) {
  const values = [
    state.backend?.version,
    state.backend?.runtimeSha,
    state.backend?.artifactDigest,
    state.backend?.installedDigest,
    state.backend?.releaseEvidence?.rcRun,
    state.backend?.releaseEvidence?.signingRun,
    state.backend?.releaseEvidence?.stagingRun,
    state.backend?.releaseEvidence?.stagingRequestId,
    state.backend?.releaseEvidence?.backup,
    state.trainingCatalog?.compiledPackageHash,
    state.trainingCatalog?.releaseSubjectHash,
    state.ios?.version,
    state.ios?.sha,
    state.ios?.refreshFixSha,
    state.ios?.prHeadSha,
    state.ios?.mainSha,
  ].filter((value) => typeof value === 'string' && value.length > 0);

  return values
    .filter((value) => !releaseSummary.includes(value))
    .map((value) => ({
      type: 'release-summary-drift',
      message: `Missing release-state value ${value}`,
    }));
}

function hostViewIssues(state, releaseSummary) {
  const issues = [];
  const invalid = (message) => issues.push({
    type: 'release-state-view-invalid',
    message,
  });

  if (state.generated !== true || state.authoritative !== false) {
    invalid('Host-derived release projection must be generated and non-authoritative.');
  }
  if (!canonicalTimestamp(state.capturedAt)) {
    invalid('Host-derived release projection requires canonical capturedAt.');
  }
  if (state.sourceSchemas?.state !== HOST_STATE_SCHEMA
      || state.sourceSchemas?.receipt !== RECEIPT_SCHEMA) {
    invalid('Host-derived release projection has unexpected source schemas.');
  }
  if (!Array.isArray(state.recent)
      || !hasOwn(state, 'active')
      || !hasOwn(state, 'activeReceipt')
      || !hasOwn(state, 'effective')
      || typeof state.effective?.provable !== 'boolean'
      || typeof state.pm2FallbackRetirementInProgress !== 'boolean'
      || typeof state.pm2FallbackRetired !== 'boolean') {
    invalid('Host-derived release projection is missing its bounded evidence view.');
  }
  if (!releaseSummary.includes('non-authoritative')
      || !releaseSummary.includes('/var/lib/nexus-release/state/release-state.json')
      || !releaseSummary.includes('/var/lib/nexus-release/receipts/')) {
    invalid('Current release summary must route readers to root-owned host evidence.');
  }
  return issues;
}

export function releaseStateDocumentationIssues({ state, releaseSummary }) {
  if (state?.schema === LEGACY_SCHEMA) {
    return legacySummaryIssues(state, releaseSummary);
  }
  if (state?.schema === HOST_VIEW_SCHEMA) {
    return hostViewIssues(state, releaseSummary);
  }
  return [{
    type: 'release-state-schema-invalid',
    message: `Unsupported release-state projection schema ${String(state?.schema ?? '')}`,
  }];
}
