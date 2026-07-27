import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const runtimeSha = 'a'.repeat(40);
const artifactDigest = 'b'.repeat(64);
const requestId = '11111111-1111-4111-8111-111111111111';

describe('protected signing resume helpers', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  function fixture(name: string) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`)));
    roots.push(root);
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(root, 'docs', 'release', 'evidence'), { recursive: true });
    fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(root, 'docs', 'release', 'evidence', 'release-evidence-public-key.pem'), 'fixture\n');
    return root;
  }

  it('watches only the persisted manifest signer run and publishes bundle first, manifest last', () => {
    const root = fixture('manifest-signing-resume');
    const operations = path.join(root, 'operations.log');
    const signedAt = new Date().toISOString();
    const runCreatedAt = new Date(
      Math.floor((Date.now() - 60_000) / 1_000) * 1_000,
    ).toISOString().replace('.000Z', 'Z');
    const manifestExpiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
    const downloadedArtifactDigest = `sha256:${'c'.repeat(64)}`;
    fs.copyFileSync(
      'scripts/request-release-manifest-signature.sh',
      path.join(root, 'scripts', 'request-release-manifest-signature.sh'),
    );
    fs.chmodSync(path.join(root, 'scripts', 'request-release-manifest-signature.sh'), 0o755);
    fs.copyFileSync(
      'scripts/release-signing-provenance-receipt.mjs',
      path.join(root, 'scripts', 'release-signing-provenance-receipt.mjs'),
    );
    fs.writeFileSync(path.join(root, 'scripts', 'release-manifest-v2.mjs'), `
import fs from 'node:fs';
fs.appendFileSync(process.env.OPERATIONS, 'validate:' + process.argv.slice(2).join(' ') + '\\n');
`);
    fs.writeFileSync(path.join(root, 'bin', 'gh'), `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2);
fs.appendFileSync(process.env.OPERATIONS,'gh:'+args.join(' ')+'\\n');
if(args[0]==='auth'&&args[1]==='status')process.exit(0);
if(args[0]==='workflow'&&args[1]==='view')process.exit(0);
if(args[0]==='workflow'&&args[1]==='run')process.exit(91);
if(args[0]==='run'&&args[1]==='view'){
 process.stdout.write(JSON.stringify({databaseId:4242,
  displayTitle:'Sign release candidate ${runtimeSha} run 123456 request ${requestId}',
  headSha:'${runtimeSha}',headBranch:'main',event:'workflow_dispatch',
  status:'completed',conclusion:'success',workflowName:'Release — Sign exact candidate'}));
 process.exit(0);
}
if(args[0]==='run'&&args[1]==='watch')process.exit(0);
if(args[0]==='api'){
 if(args[1].endsWith('/artifacts?per_page=100')){
  process.stdout.write(JSON.stringify({artifacts:[{id:9001,
   name:'release-manifest-v2-${runtimeSha}',size_in_bytes:4096,
   digest:'${downloadedArtifactDigest}',expired:false,
   workflow_run:{id:4242,head_sha:'${runtimeSha}'}}]}));
 }else{
  process.stdout.write(JSON.stringify({id:4242,run_attempt:1,
   name:'Sign release candidate ${runtimeSha} run 123456 request ${requestId}',
   display_title:'Sign release candidate ${runtimeSha} run 123456 request ${requestId}',
   path:'.github/workflows/sign-release-manifest.yml',
   event:'workflow_dispatch',head_branch:'main',head_sha:'${runtimeSha}',
   status:'completed',conclusion:'success',created_at:'${runCreatedAt}',
   repository:{full_name:'felipedrf74/cortex-telegram-hub-bot'}}));
 }
 process.exit(0);
}
if(args[0]==='run'&&args[1]==='download'){
 const output=args[args.indexOf('--dir')+1];
 const release=path.join(output,'.local','release');
 fs.mkdirSync(path.join(release,'manifests'),{recursive:true});
 fs.mkdirSync(path.join(release,'bundles','${runtimeSha}','${artifactDigest}'),{recursive:true});
 fs.writeFileSync(path.join(release,'manifests','${runtimeSha}.json'),
  JSON.stringify({schema:'nexus.release-manifest.v2',payload:{
   runtimeSha:'${runtimeSha}',source:{dirty:false},expiresAt:'${manifestExpiresAt}',
   artifact:{digest:'${artifactDigest}'},
   ci:{provider:'github-actions',workflow:'RC — Release Evidence',
    runId:'123456',runAttempt:'1'}}})+'\\n');
 fs.writeFileSync(path.join(release,'bundles','${runtimeSha}','${artifactDigest}','.complete.json'),'{}\\n');
 fs.writeFileSync(path.join(release,'signing-provenance.json'),JSON.stringify({
  schema:'nexus.release-signing-provenance.v3',runtimeSha:'${runtimeSha}',
  artifactDigest:'${artifactDigest}',candidateRunId:'123456',candidateRunAttempt:'1',
  candidateArtifactId:'7001',candidateArtifactDigest:'sha256:${'d'.repeat(64)}',
  nightlyRunId:null,nightlyArtifactId:null,nightlyArtifactDigest:null,
  iosEvidenceRunId:null,iosEvidenceRunAttempt:null,iosAttestationDigest:null,
  iosContractDigest:null,iosContractFixtureDigest:null,
  iosDistributionAttestationDigest:null,iosDistributionPayloadDigest:null,
  iosDistributionCiBuildId:null,signingRunId:'4242',signingRunAttempt:'1',
  trustedToolingSha:'${runtimeSha}',keyId:'release-evidence-v1',
  signedAt:'${signedAt}'})+'\\n');
 process.exit(0);
}
process.exit(92);
`, { mode: 0o755 });

    const invoke = () => spawnSync('bash', [
      'scripts/request-release-manifest-signature.sh',
      runtimeSha,
      '123456',
      root,
      '--backend-only',
      '--request-id', requestId,
      '--run-id', '4242',
    ], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        OPERATIONS: operations,
        PATH: `${path.join(root, 'bin')}:${process.env.PATH ?? ''}`,
      },
    });

    const first = invoke();
    expect(first.status, first.stderr).toBe(0);
    const manifest = path.join(root, '.local', 'release', 'manifests', `${runtimeSha}.json`);
    const bundle = path.join(root, '.local', 'release', 'bundles', runtimeSha, artifactDigest);
    const receipt = path.join(
      root,
      '.local',
      'release',
      'signing-provenance',
      `${runtimeSha}.json`,
    );
    expect(fs.statSync(manifest).mode & 0o777).toBe(0o600);
    expect(fs.statSync(receipt).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(path.join(bundle, '.complete.json'))).toBe(true);
    expect(JSON.parse(fs.readFileSync(receipt, 'utf8'))).toMatchObject({
      repository: 'felipedrf74/cortex-telegram-hub-bot',
      runtimeSha,
      candidate: { runId: '123456', runAttempt: '1' },
      protectedSigning: {
        runId: '4242',
        runAttempt: '1',
        workflow: 'Release — Sign exact candidate',
        workflowPath: '.github/workflows/sign-release-manifest.yml',
      },
      downloadedArtifact: {
        artifactId: '9001',
        artifactDigest: downloadedArtifactDigest,
      },
      manifest: { artifactDigest },
    });
    const liveRun = path.join(root, 'live-signing-run.json');
    const liveArtifacts = path.join(root, 'live-signing-artifacts.json');
    const liveRunIdentity = {
      id: 4242,
      run_attempt: 1,
      name: `Sign release candidate ${runtimeSha} run 123456 request ${requestId}`,
      display_title:
        `Sign release candidate ${runtimeSha} run 123456 request ${requestId}`,
      path: '.github/workflows/sign-release-manifest.yml',
      event: 'workflow_dispatch',
      head_branch: 'main',
      head_sha: runtimeSha,
      status: 'completed',
      conclusion: 'success',
      created_at: runCreatedAt,
      repository: { full_name: 'felipedrf74/cortex-telegram-hub-bot' },
    };
    fs.writeFileSync(
      liveRun,
      `${JSON.stringify(liveRunIdentity)}\n`,
      { mode: 0o600 },
    );
    fs.writeFileSync(liveArtifacts, `${JSON.stringify({
      artifacts: [{
        id: 9001,
        name: `release-manifest-v2-${runtimeSha}`,
        size_in_bytes: 4096,
        digest: downloadedArtifactDigest,
        expired: false,
        workflow_run: { id: 4242, head_sha: runtimeSha },
      }],
    })}\n`, { mode: 0o600 });
    const verifyReceipt = (candidateReceipt: string) => spawnSync(
      process.execPath,
      [
        path.join(root, 'scripts', 'release-signing-provenance-receipt.mjs'),
        'verify',
        '--receipt', candidateReceipt,
        '--manifest', manifest,
        '--expect-runtime-sha', runtimeSha,
        '--run-metadata', liveRun,
        '--artifact-metadata', liveArtifacts,
      ],
      { cwd: root, encoding: 'utf8' },
    );
    expect(verifyReceipt(receipt).status).toBe(0);
    fs.writeFileSync(
      liveRun,
      `${JSON.stringify({
        ...liveRunIdentity,
        name: 'forged release signing title',
        display_title: 'forged release signing title',
      })}\n`,
      { mode: 0o600 },
    );
    expect(verifyReceipt(receipt).status).not.toBe(0);
    fs.writeFileSync(
      liveRun,
      `${JSON.stringify(liveRunIdentity)}\n`,
      { mode: 0o600 },
    );
    const exactReceipt = JSON.parse(fs.readFileSync(receipt, 'utf8'));
    const substitutions: Array<{
      label: string;
      mutate: (value: any) => void;
    }> = [
      {
        label: 'RC run',
        mutate: (value) => {
          value.protectedSigning.runId = '123456';
          value.sourceProvenance.signingRunId = '123456';
          value.downloadedArtifact.workflowRunId = '123456';
        },
      },
      {
        label: 'cross SHA',
        mutate: (value) => {
          value.runtimeSha = 'e'.repeat(40);
          value.protectedSigning.headSha = 'e'.repeat(40);
          value.downloadedArtifact.workflowHeadSha = 'e'.repeat(40);
          value.downloadedArtifact.artifactName =
            `release-manifest-v2-${'e'.repeat(40)}`;
        },
      },
      {
        label: 'cross repository',
        mutate: (value) => {
          value.repository = 'attacker/example';
        },
      },
      {
        label: 'cross workflow',
        mutate: (value) => {
          value.protectedSigning.workflow = 'RC — Release Evidence';
          value.protectedSigning.workflowPath = '.github/workflows/rc.yml';
        },
      },
      {
        label: 'cross attempt',
        mutate: (value) => {
          value.protectedSigning.runAttempt = '2';
          value.sourceProvenance.signingRunAttempt = '2';
        },
      },
      {
        label: 'artifact identity',
        mutate: (value) => {
          value.downloadedArtifact.artifactDigest = `sha256:${'f'.repeat(64)}`;
        },
      },
      {
        label: 'stale receipt',
        mutate: (value) => {
          const stale = new Date(Date.now() - 25 * 60 * 60_000).toISOString();
          value.recordedAt = stale;
          value.sourceProvenance.signedAt = stale;
          value.protectedSigning.createdAt = stale;
        },
      },
    ];
    for (const substitution of substitutions) {
      const value = structuredClone(exactReceipt);
      substitution.mutate(value);
      const candidateReceipt = path.join(
        root,
        `substituted-${substitution.label.replaceAll(' ', '-')}.json`,
      );
      fs.writeFileSync(
        candidateReceipt,
        `${JSON.stringify(value)}\n`,
        { mode: 0o600 },
      );
      expect(
        verifyReceipt(candidateReceipt).status,
        substitution.label,
      ).not.toBe(0);
    }
    const truncatedReceipt = path.join(root, 'truncated-receipt.json');
    fs.writeFileSync(truncatedReceipt, '{"schema":', { mode: 0o600 });
    expect(verifyReceipt(truncatedReceipt).status).not.toBe(0);
    expect(fs.readFileSync(operations, 'utf8')).not.toContain('gh:workflow run');

    const exact = fs.readFileSync(manifest);
    expect(invoke().status).toBe(0);
    expect(fs.readFileSync(manifest)).toEqual(exact);
    fs.writeFileSync(manifest, 'tampered\n', { mode: 0o600 });
    const tampered = invoke();
    expect(tampered.status).not.toBe(0);
    expect(tampered.stderr).toContain('existing signed manifest differs');
    expect(fs.readFileSync(manifest, 'utf8')).toBe('tampered\n');
  });

  it('watches only the persisted staging signer run and atomically refuses destination drift', () => {
    const root = fixture('staging-signing-resume');
    const operations = path.join(root, 'operations.log');
    fs.copyFileSync(
      'scripts/request-staging-attestation.sh',
      path.join(root, 'scripts', 'request-staging-attestation.sh'),
    );
    fs.chmodSync(path.join(root, 'scripts', 'request-staging-attestation.sh'), 0o755);
    fs.writeFileSync(path.join(root, 'scripts', 'release-staging-attestation.mjs'), `
import fs from 'node:fs';
fs.appendFileSync(process.env.OPERATIONS, 'validate:' + process.argv.slice(2).join(' ') + '\\n');
`);
    const request = path.join(root, 'request.json');
    const manifest = path.join(root, 'manifest.json');
    const output = path.join(root, '.local', 'release', 'staging', 'signed.json');
    const requestPayload = {
      schema: 'nexus.staging-attestation-request.v1',
      requestId,
      runtimeSha,
      installedRuntimeDigest: 'c'.repeat(64),
      recoveryRuntimeDigest: 'd'.repeat(64),
      verifiedAt: '2026-07-24T12:00:00.000Z',
    };
    const requestBody = `${JSON.stringify(requestPayload)}\n`;
    const requestSha256 = createHash('sha256').update(requestBody).digest('hex');
    fs.writeFileSync(request, requestBody, { mode: 0o600 });
    fs.writeFileSync(manifest, '{}\n', { mode: 0o600 });
    fs.writeFileSync(path.join(root, 'bin', 'gh'), `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2);
fs.appendFileSync(process.env.OPERATIONS,'gh:'+args.join(' ')+'\\n');
if(args[0]==='auth'&&args[1]==='status')process.exit(0);
if(args[0]==='workflow'&&args[1]==='view')process.exit(0);
if(args[0]==='workflow'&&args[1]==='run')process.exit(91);
if(args[0]==='run'&&args[1]==='view'){
 process.stdout.write(JSON.stringify({databaseId:4343,
  displayTitle:'Sign staging_attestation ${requestId} digest ${requestSha256}',headSha:'${runtimeSha}',
  headBranch:'main',event:'workflow_dispatch',status:'completed',conclusion:'success',
  workflowName:'Release — Sign staging attestation'}));
 process.exit(0);
}
if(args[0]==='run'&&args[1]==='watch')process.exit(0);
if(args[0]==='run'&&args[1]==='download'){
 const directory=args[args.indexOf('--dir')+1];
 fs.mkdirSync(directory,{recursive:true});
 const payload={...${JSON.stringify(requestPayload)},protectedSigning:{
  workflow:'.github/workflows/sign-staging-attestation.yml',runId:'4343',runAttempt:'1',
  requestedAt:process.env.SIGNED_REQUESTED_AT||'2026-07-24T11:59:55.000Z',
  signedAt:'2026-07-24T12:00:02.000Z'}};
 if(process.env.SIGNED_PAYLOAD_DRIFT==='1')payload.installedRuntimeDigest='e'.repeat(64);
 fs.writeFileSync(path.join(directory,'staging-attestation.json'),
  JSON.stringify({schema:'nexus.staging-attestation.v1',payload,signature:'fixture'})+'\\n');
 process.exit(0);
}
process.exit(92);
`, { mode: 0o755 });

    const invoke = (extraEnv: NodeJS.ProcessEnv = process.env) => spawnSync('bash', [
      'scripts/request-staging-attestation.sh',
      request,
      manifest,
      output,
      '--run-id', '4343',
    ], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...extraEnv,
        OPERATIONS: operations,
        PATH: `${path.join(root, 'bin')}:${process.env.PATH ?? ''}`,
      },
    });

    const driftedPayload = invoke({ ...process.env, SIGNED_PAYLOAD_DRIFT: '1' });
    expect(driftedPayload.status).not.toBe(0);
    expect(driftedPayload.stderr).toContain(
      'signed staging payload differs from the exact checkpointed request',
    );
    expect(fs.existsSync(output)).toBe(false);

    const excessiveSkew = invoke({
      ...process.env,
      SIGNED_REQUESTED_AT: '2026-07-24T11:59:54.999Z',
    });
    expect(excessiveSkew.status).not.toBe(0);
    expect(excessiveSkew.stderr).toContain(
      'signed staging payload lacks protected signing timing',
    );
    expect(fs.existsSync(output)).toBe(false);

    const first = invoke();
    expect(first.status, first.stderr).toBe(0);
    expect(fs.statSync(output).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(operations, 'utf8')).not.toContain('gh:workflow run');
    const exact = fs.readFileSync(output);
    expect(invoke().status).toBe(0);
    expect(fs.readFileSync(output)).toEqual(exact);
    fs.writeFileSync(output, 'tampered\n', { mode: 0o600 });
    const tampered = invoke();
    expect(tampered.status).not.toBe(0);
    expect(tampered.stderr).toContain('existing staging attestation differs');
    expect(fs.readFileSync(output, 'utf8')).toBe('tampered\n');
  });
});
