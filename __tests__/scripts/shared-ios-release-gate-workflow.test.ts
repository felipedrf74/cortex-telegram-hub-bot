import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');
const workflow = readFileSync(
  path.join(root, '.github/workflows/shared-ios-release-gate.yml'),
  'utf8',
);

const requiredInputs = [
  'backend_runtime_sha',
  'checkpoint_run_id',
  'checkpoint_run_attempt',
  'ios_sha',
  'ios_source_build_number',
  'production_state_base64',
  'ios_contract_attestation_base64',
  'ios_distribution_attestation_base64',
] as const;

function workflowDispatchInputs(source: string) {
  const block = source.match(
    /^  workflow_dispatch:\n    inputs:\n(?<body>[\s\S]*?)(?=^permissions:)/m,
  )?.groups?.body;
  expect(block, 'workflow_dispatch inputs block').toBeDefined();
  const names = [...(block ?? '').matchAll(/^      ([a-z0-9_]+):$/gm)]
    .map((match) => match[1]);
  return { block: block ?? '', names };
}

function inputBody(block: string, name: string) {
  return block.match(
    new RegExp(`      ${name}:\\n(?<body>[\\s\\S]*?)(?=\\n      [a-z0-9_]+:\\n|$)`),
  )?.groups?.body ?? '';
}

function runBody(stepName: string) {
  return workflow.match(
    new RegExp(`      - name: ${stepName}\\n(?<body>[\\s\\S]*?)(?=\\n      - (?:name|uses):|$)`),
  )?.groups?.body ?? '';
}

describe('retained shared iOS fallback evidence workflow', () => {
  it('is owner-dispatched, fallback-only, decoupled, and least privilege', () => {
    expect(workflow).toContain('name: Shared iOS Release Gate — post-production');
    expect(workflow).toContain('retained only with the PM2 first-cutover');
    expect(workflow).toContain('never couples the independently governed backend and iOS release cadences');
    expect(workflow).not.toMatch(/^  (?:push|pull_request|schedule):/m);
    expect(workflow).toContain('environment:\n      name: production-release');
    expect(workflow).toContain('permissions:\n  actions: read\n  contents: read');
    expect(workflow).not.toMatch(/^\s{2}(?:deployments|id-token|packages|pull-requests): write$/m);
    expect(workflow).toContain('test "$GITHUB_ACTOR" = "$GITHUB_REPOSITORY_OWNER"');
    expect(workflow).toContain('test "$(git rev-parse origin/main)" = "$BACKEND_RUNTIME_SHA"');
  });

  it('requires and consumes every immutable release identity and evidence input', () => {
    const inputs = workflowDispatchInputs(workflow);
    expect(inputs.names).toEqual(requiredInputs);
    for (const name of requiredInputs) {
      expect(inputBody(inputs.block, name), `${name} must be required`).toContain('required: true');
      expect(workflow, `${name} must be consumed`).toContain(`\${{ inputs.${name} }}`);
    }

    const materialize = runBody('Materialize bounded canonical evidence');
    expect(materialize).toContain('materializeCanonicalBase64');
    expect(materialize).toContain("decoded.toString('base64') !== encoded");
    expect(materialize).toContain('decoded.length > maxBytes');
    expect(materialize).toContain("materializeCanonicalBase64('PRODUCTION_STATE_BASE64'");
    expect(materialize).toContain("materializeCanonicalBase64('IOS_CONTRACT_ATTESTATION_BASE64'");
    expect(materialize).toContain("materializeCanonicalBase64('IOS_DISTRIBUTION_ATTESTATION_BASE64'");
  });

  it('downloads the exact manifest and bundle artifacts from one checkpoint run', () => {
    const checkpoint = runBody('Resolve exact successful checkpoint artifact');
    expect(checkpoint).toContain('.github/workflows/release-candidate-evidence.yml');
    expect(checkpoint).toContain('.head_sha==$sha');
    expect(checkpoint).toContain('.head_branch=="main"');
    expect(checkpoint).toContain('.event=="workflow_dispatch"');
    expect(checkpoint).toContain('.run_attempt==($attempt|tonumber)');
    expect(checkpoint).toContain('release-checkpoint-$BACKEND_RUNTIME_SHA');
    expect(checkpoint).toContain('artifact_id=');

    const manifest = runBody('Bind manifest to checkpoint-built artifact identity');
    expect(manifest).toContain('manifest.releaseCheckpoint?.runId !== checkpointRunId');
    expect(manifest).toContain('manifest.releaseCheckpoint?.runAttempt !== checkpointRunAttempt');
    expect(manifest).toContain("manifest.releaseCheckpoint.workflow !== 'release-candidate-evidence.yml'");
    expect(manifest).toContain("manifest.protectedMain.workflow !== 'ci.yml'");
    expect(manifest).toContain('fs.fchmodSync(directoryDescriptor, 0o700)');
    expect(manifest).toContain('fs.fchmodSync(fileDescriptor, 0o600)');
    expect(manifest).toContain('(securedDirectory.mode & 0o777) !== 0o700');
    expect(manifest).toContain('(securedFile.mode & 0o777) !== 0o600');
    expect(manifest).toContain('bundle_artifact_name=');

    const checkpointBundle = runBody('Resolve exact successful checkpoint bundle artifact');
    expect(checkpointBundle).toContain(
      'CHECKPOINT_RUN_ID: ${{ steps.checkpoint.outputs.run_id }}',
    );
    expect(checkpointBundle).toContain(
      'actions/runs/$CHECKPOINT_RUN_ID/artifacts?per_page=100',
    );
    expect(checkpointBundle).toContain('BUNDLE_ARTIFACT_NAME');
    expect(checkpointBundle).toContain('artifact_id=');
    expect(checkpointBundle).not.toContain('.github/workflows/ci.yml');

    const downloads = [...workflow.matchAll(
      /uses: actions\/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c[\s\S]*?artifact-ids: \$\{\{ steps\.(checkpoint|checkpoint_bundle)\.outputs\.artifact_id \}\}[\s\S]*?run-id: \$\{\{ steps\.\1\.outputs\.run_id \}\}/g,
    )];
    expect(downloads.map((match) => match[1])).toEqual(['checkpoint', 'checkpoint_bundle']);
  });

  it('runs every shared-gate validation input and uploads only its revalidated passing receipt', () => {
    const gate = runBody('Run exact shared backend and iOS release gate');
    const flags = [...gate.matchAll(/^\s{10}(--[a-z0-9-]+)(?: |$)/gm)]
      .map((match) => match[1]);
    expect(flags).toEqual([
      '--manifest',
      '--bundle',
      '--production-state',
      '--ios-contract-attestation',
      '--ios-distribution-attestation',
      '--expect-backend-runtime-sha',
      '--expect-ios-sha',
      '--expect-ios-build-number',
      '--output',
    ]);

    const gateIndex = workflow.indexOf('- name: Run exact shared backend and iOS release gate');
    const receiptIndex = workflow.indexOf('- name: Revalidate passing receipt identity');
    const uploadIndex = workflow.indexOf('uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a');
    expect(gateIndex).toBeGreaterThan(-1);
    expect(receiptIndex).toBeGreaterThan(gateIndex);
    expect(uploadIndex).toBeGreaterThan(receiptIndex);

    const receipt = runBody('Revalidate passing receipt identity');
    expect(receipt).toContain("receipt.schema !== 'nexus.shared-ios-release-gate.v1'");
    expect(receipt).toContain("receipt.result !== 'passed'");
    expect(receipt).toContain('receipt.backend?.runtimeSha !== backendSha');
    expect(receipt).toContain('receipt.ios?.sourceSha !== iosSha');
    expect(receipt).toContain('receipt.ios?.sourceBuildNumber !== iosBuild');
    expect(workflow).toContain('path: .local/shared-ios-release-gate/shared-ios-release-gate-receipt.json');
    expect(workflow).toContain('if-no-files-found: error');
  });
});
