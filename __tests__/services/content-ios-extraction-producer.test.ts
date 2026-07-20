import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  digestContentIosXcresultBundle,
  extractContentIosXcresultEvidence,
  produceContentIosExtractionArtifact,
  readContentIosAttachmentEvidenceFromExportDirectory,
  resolveContentIosSourceIdentity,
} from '../../src/services/content-ios-extraction-producer';
import {
  CONTENT_IOS_EXTRACTION_TEST_IDENTIFIERS,
  CONTENT_IOS_TEST_EVIDENCE_ATTACHMENT_NAME,
} from '../../src/services/content-ios-extraction-artifact';
import { makeContentIosXcresultDocuments } from '../fixtures/content-ios-extraction';
import { writeContentIosExtractionOutputSet } from '../../scripts/create-content-ios-extraction-artifact';

const REPO_ROOT = path.resolve(__dirname, '../..');
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeAttachmentExport(): { directory: string; manifest: Array<Record<string, unknown>>; attachmentsJson: string } {
  const directory = tempDir('content-ios-attachment-export-');
  return writeAttachmentExport(directory);
}

function writeAttachmentExport(directory: string): {
  directory: string;
  manifest: Array<Record<string, unknown>>;
  attachmentsJson: string;
} {
  const { attachmentsJson } = makeContentIosXcresultDocuments();
  const attachments = JSON.parse(attachmentsJson) as Array<Record<string, unknown>>;
  const manifest = CONTENT_IOS_EXTRACTION_TEST_IDENTIFIERS.map((testIdentifier, index) => {
    const fileName = `attachment-${index}.json`;
    writeFileSync(path.join(directory, fileName), JSON.stringify(attachments[index]));
    return {
      testIdentifier: `Nexus HubUITests/${testIdentifier}()`,
      attachments: [{
        exportedFileName: fileName,
        suggestedHumanReadableName: CONTENT_IOS_TEST_EVIDENCE_ATTACHMENT_NAME,
        isAssociatedWithFailure: false,
        configurationName: 'Test',
        deviceName: 'iPhone',
        deviceId: 'fixture-device',
      }],
    };
  });
  writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
  return { directory, manifest, attachmentsJson };
}

describe('Content iOS extraction executable producer', () => {
  it('deterministically digests every xcresult bundle byte and detects tampering', () => {
    const bundle = path.join(tempDir('content-ios-xcresult-'), 'Content.xcresult');
    mkdirSync(path.join(bundle, 'Data'), { recursive: true });
    writeFileSync(path.join(bundle, 'Info.plist'), 'fixture-info');
    writeFileSync(path.join(bundle, 'Data', 'payload'), 'fixture-payload');
    const first = digestContentIosXcresultBundle(bundle);
    const second = digestContentIosXcresultBundle(bundle);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(second).toBe(first);
    writeFileSync(path.join(bundle, 'Data', 'payload'), 'tampered-payload');
    expect(digestContentIosXcresultBundle(bundle)).not.toBe(first);
  });

  it('rejects caller-supplied symlinks for xcresult and attachment-export roots', () => {
    const root = tempDir('content-ios-root-symlink-');
    const bundle = path.join(root, 'Content.xcresult');
    mkdirSync(bundle);
    writeFileSync(path.join(bundle, 'Info.plist'), 'fixture-info');
    const bundleLink = path.join(root, 'Content-link.xcresult');
    symlinkSync(bundle, bundleLink, 'dir');
    expect(() => digestContentIosXcresultBundle(bundleLink))
      .toThrow('CONTENT_IOS_EXTRACTION_XCRESULT_NOT_REGULAR_DIRECTORY');

    const attachmentExport = makeAttachmentExport();
    const attachmentLink = path.join(root, 'attachment-link');
    symlinkSync(attachmentExport.directory, attachmentLink, 'dir');
    expect(() => readContentIosAttachmentEvidenceFromExportDirectory(attachmentLink))
      .toThrow('CONTENT_IOS_EXTRACTION_ATTACHMENT_EXPORT_INVALID');
  });

  it('rejects an xcresult bundle that changes while Apple documents are extracted', () => {
    const bundle = path.join(tempDir('content-ios-mutating-xcresult-'), 'Content.xcresult');
    mkdirSync(path.join(bundle, 'Data'), { recursive: true });
    writeFileSync(path.join(bundle, 'Info.plist'), 'fixture-info');
    const payloadPath = path.join(bundle, 'Data', 'payload');
    writeFileSync(payloadPath, 'initial-payload');
    const documents = makeContentIosXcresultDocuments();

    expect(() => extractContentIosXcresultEvidence(bundle, {
      exec: (_executable, args) => {
        if (args[1] === 'get' && args[3] === 'tests') return documents.testsJson;
        if (args[1] === 'get' && args[3] === 'summary') return documents.summaryJson;
        if (args[1] === 'export' && args[2] === 'attachments') {
          const outputIndex = args.indexOf('--output-path');
          writeAttachmentExport(args[outputIndex + 1]);
          writeFileSync(payloadPath, 'mutated-during-extraction');
          return '';
        }
        throw new Error(`unexpected xcresulttool arguments: ${args.join(' ')}`);
      },
    })).toThrow('CONTENT_IOS_EXTRACTION_XCRESULT_MUTATED_DURING_EXTRACTION');
  });

  it('derives SHA and tree digest from a clean repo and refuses a dirty source tree', () => {
    const repo = tempDir('content-ios-source-');
    execFileSync('/usr/bin/git', ['init', '-q'], { cwd: repo });
    writeFileSync(path.join(repo, 'Fixture.swift'), 'struct Fixture {}\n');
    execFileSync('/usr/bin/git', ['add', 'Fixture.swift'], { cwd: repo });
    execFileSync('/usr/bin/git', [
      '-c', 'user.name=Nexus Test', '-c', 'user.email=nexus@example.invalid',
      'commit', '-q', '-m', 'fixture',
    ], { cwd: repo });

    const identity = resolveContentIosSourceIdentity(repo);
    expect(identity.gitCommit).toMatch(/^[a-f0-9]{40}$/);
    expect(identity.sourceTreeDigest).toMatch(/^[a-f0-9]{64}$/);

    writeFileSync(path.join(repo, 'Fixture.swift'), 'struct Fixture { let changed = true }\n');
    expect(() => resolveContentIosSourceIdentity(repo))
      .toThrow('CONTENT_IOS_EXTRACTION_IOS_TREE_NOT_CLEAN');
  });

  it('rejects an iOS source identity that changes while result evidence is extracted', () => {
    const documents = makeContentIosXcresultDocuments();
    let identityRead = 0;
    expect(() => produceContentIosExtractionArtifact({
      xcresultPath: '/unused/Content.xcresult',
      iosRepoPath: '/unused/ios-repo',
      attestationKey: Buffer.alloc(32, 0x69),
    }, {
      resolveSourceIdentity: () => ({
        gitCommit: identityRead++ === 0 ? 'd'.repeat(40) : 'f'.repeat(40),
        sourceTreeDigest: 'e'.repeat(64),
      }),
      extractEvidence: () => ({
        xcresultDigest: 'a'.repeat(64),
        ...documents,
      }),
    })).toThrow('CONTENT_IOS_EXTRACTION_IOS_SOURCE_MUTATED_DURING_EXTRACTION');
  });

  it('extracts exactly one named, non-failure evidence attachment for every fixed test', () => {
    const fixture = makeAttachmentExport();
    expect(JSON.parse(readContentIosAttachmentEvidenceFromExportDirectory(fixture.directory)))
      .toEqual(JSON.parse(fixture.attachmentsJson));
  });

  it('rejects missing, duplicate, failure-associated, and path-traversing attachments', () => {
    const missing = makeAttachmentExport();
    (missing.manifest[0].attachments as unknown[]) = [];
    writeFileSync(path.join(missing.directory, 'manifest.json'), JSON.stringify(missing.manifest));
    expect(() => readContentIosAttachmentEvidenceFromExportDirectory(missing.directory))
      .toThrow('CONTENT_IOS_EXTRACTION_ATTACHMENT_COUNT_INVALID');

    const duplicate = makeAttachmentExport();
    const firstAttachments = duplicate.manifest[0].attachments as Array<Record<string, unknown>>;
    firstAttachments.push({ ...firstAttachments[0] });
    writeFileSync(path.join(duplicate.directory, 'manifest.json'), JSON.stringify(duplicate.manifest));
    expect(() => readContentIosAttachmentEvidenceFromExportDirectory(duplicate.directory))
      .toThrow('CONTENT_IOS_EXTRACTION_ATTACHMENT_COUNT_INVALID');

    const failure = makeAttachmentExport();
    ((failure.manifest[0].attachments as Array<Record<string, unknown>>)[0]).isAssociatedWithFailure = true;
    writeFileSync(path.join(failure.directory, 'manifest.json'), JSON.stringify(failure.manifest));
    expect(() => readContentIosAttachmentEvidenceFromExportDirectory(failure.directory))
      .toThrow('CONTENT_IOS_EXTRACTION_ATTACHMENT_METADATA_INVALID');

    const traversal = makeAttachmentExport();
    ((traversal.manifest[0].attachments as Array<Record<string, unknown>>)[0]).exportedFileName = '../escape.json';
    writeFileSync(path.join(traversal.directory, 'manifest.json'), JSON.stringify(traversal.manifest));
    expect(() => readContentIosAttachmentEvidenceFromExportDirectory(traversal.directory))
      .toThrow('CONTENT_IOS_EXTRACTION_ATTACHMENT_PATH_INVALID');
  });

  it('exposes a runnable CLI with no caller-supplied score, status, test ID, or SHA options', () => {
    const help = spawnSync(process.execPath, [
      '--import', 'tsx', 'scripts/create-content-ios-extraction-artifact.ts', '--help',
    ], { cwd: REPO_ROOT, encoding: 'utf8' });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('--xcresult');
    expect(help.stdout).toContain('does not accept caller-supplied scores');

    const forged = spawnSync(process.execPath, [
      '--import', 'tsx', 'scripts/create-content-ios-extraction-artifact.ts',
      '--test-status', 'Passed',
    ], { cwd: REPO_ROOT, encoding: 'utf8' });
    expect(forged.status).not.toBe(0);
    expect(forged.stderr).toContain('Unknown Content iOS extraction argument');
  });

  it('publishes one private output set and rolls back every linked file after a late failure', () => {
    const outputDirectory = tempDir('content-ios-output-set-');
    const outputs = ['tests.json', 'summary.json', 'attachments.json', 'artifact.json'].map((name, index) => ({
      filePath: path.join(outputDirectory, name),
      value: `value-${index}`,
    }));
    writeContentIosExtractionOutputSet(outputs);
    for (const [index, output] of outputs.entries()) {
      expect(readFileSync(output.filePath, 'utf8')).toBe(`value-${index}`);
      expect(statSync(output.filePath).mode & 0o777).toBe(0o600);
    }

    const rollbackDirectory = tempDir('content-ios-output-rollback-');
    const rollbackOutputs = outputs.map((output) => ({
      ...output,
      filePath: path.join(rollbackDirectory, path.basename(output.filePath)),
    }));
    let linkCount = 0;
    expect(() => writeContentIosExtractionOutputSet(rollbackOutputs, {
      link: (existingPath, newPath) => {
        linkCount += 1;
        if (linkCount === 3) throw new Error('simulated-late-output-failure');
        linkSync(existingPath, newPath);
      },
    })).toThrow('simulated-late-output-failure');
    expect(rollbackOutputs.every((output) => !existsSync(output.filePath))).toBe(true);
    expect(readdirSync(rollbackDirectory)).toHaveLength(0);
  });
});
