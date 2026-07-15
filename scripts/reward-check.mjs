#!/usr/bin/env node
// Copyright (c) 2026 Felipe Dominguez. MIT License. See LICENSE.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const POLICY_VERSION = '2026-06-16';
export const RUN_VERSION = '1.0.0';
export const VERDICTS = ['PASS', 'WARN', 'FAIL', 'MANUAL_REQUIRED', 'NOT_APPLICABLE'];
export const AREAS = ['backend', 'ios', 'docs', 'release', 'research', 'auto'];

const DEFAULT_TIMEOUT_MS = 60_000;
const BOUNDED_OUTPUT_CHARS = 3000;

export function parseArgs(argv) {
  const parsed = {
    area: 'auto',
    advisory: true,
    enforce: false,
    json: false,
    handoff: null,
    output: null,
    changedFilesPath: null,
    releaseManifest: null,
    stagingAttestation: null,
    requireStaging: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--area') parsed.area = argv[++index] || 'auto';
    else if (arg.startsWith('--area=')) parsed.area = arg.slice('--area='.length);
    else if (arg === '--handoff') parsed.handoff = argv[++index] || null;
    else if (arg.startsWith('--handoff=')) parsed.handoff = arg.slice('--handoff='.length);
    else if (arg === '--output') parsed.output = argv[++index] || null;
    else if (arg.startsWith('--output=')) parsed.output = arg.slice('--output='.length);
    else if (arg === '--changed-files') parsed.changedFilesPath = argv[++index] || null;
    else if (arg.startsWith('--changed-files=')) parsed.changedFilesPath = arg.slice('--changed-files='.length);
    else if (arg === '--release-manifest') parsed.releaseManifest = argv[++index] || null;
    else if (arg.startsWith('--release-manifest=')) parsed.releaseManifest = arg.slice('--release-manifest='.length);
    else if (arg === '--staging-attestation') parsed.stagingAttestation = argv[++index] || null;
    else if (arg.startsWith('--staging-attestation=')) parsed.stagingAttestation = arg.slice('--staging-attestation='.length);
    else if (arg === '--require-staging') parsed.requireStaging = true;
    else if (arg === '--json') parsed.json = true;
    else if (arg === '--advisory') {
      parsed.advisory = true;
      parsed.enforce = false;
    } else if (arg === '--enforce') {
      parsed.enforce = true;
      parsed.advisory = false;
    } else if (arg === '-h' || arg === '--help') {
      parsed.help = true;
    } else {
      parsed.unknown = parsed.unknown || [];
      parsed.unknown.push(arg);
    }
  }

  if (!AREAS.includes(parsed.area)) {
    throw new Error(`invalid --area '${parsed.area}', expected one of ${AREAS.join(', ')}`);
  }

  return parsed;
}

export function usage() {
  return `Usage:
  node scripts/reward-check.mjs --area auto --advisory
  node scripts/reward-check.mjs --area backend --json --output .local/reward-runs/run.json
  node scripts/reward-check.mjs --area release --enforce --release-manifest .local/release/manifests/<sha>.json

Options:
  --area backend|ios|docs|release|research|auto
  --handoff <path>
  --json
  --advisory
  --enforce
  --output <path>
  --changed-files <path>
  --release-manifest <path>
  --staging-attestation <path>
  --require-staging`;
}

export function buildRewardRun(options = {}) {
  const cwd = options.cwd || process.cwd();
  const runId = options.runId || crypto.randomUUID();
  const timestamp = options.timestamp || new Date().toISOString();
  const env = options.env || process.env;

  const repo = getRepoInfo(cwd);
  const changedFiles = collectChangedFiles(cwd, repo.baseRef, options.changedFilesPath);
  const requestedArea = options.area || 'auto';
  const area = requestedArea === 'auto' ? inferArea(changedFiles) : requestedArea;
  const classifier = runClassifier(cwd, changedFiles);
  const handoff = readHandoff(cwd, options.handoff);
  const redactions = detectSensitiveContent([
    handoff.content || '',
    changedFiles.join('\n'),
    JSON.stringify(classifier.result || {}),
  ]);

  const context = {
    cwd,
    env,
    requestedArea,
    area,
    changedFiles,
    handoff,
    classifier,
    redactions,
    releaseManifest: options.releaseManifest || null,
    stagingAttestation: options.stagingAttestation || null,
    requireStaging: Boolean(options.requireStaging),
  };

  const mandatoryChecks = [];
  const optionalChecks = [];
  const skippedChecks = [];
  const hardFailures = [];
  const signals = [];
  const evidence = [];

  signals.push({
    id: 'area-selection',
    label: 'Area selection',
    status: area === 'auto' ? 'NOT_APPLICABLE' : 'PASS',
    details: { requestedArea, effectiveArea: area },
  });

  if (changedFiles.length === 0 && !handoff.path) {
    signals.push({
      id: 'no-changed-files',
      label: 'No changed files or handoff supplied',
      status: 'NOT_APPLICABLE',
      details: {},
    });
  }

  mandatoryChecks.push(classifierCheck(classifier));
  mandatoryChecks.push(...buildAreaChecks(context));
  optionalChecks.push(...buildOptionalChecks(context));
  skippedChecks.push(...mandatoryChecks.filter((check) => check.status === 'SKIPPED'));
  skippedChecks.push(...optionalChecks.filter((check) => check.status === 'SKIPPED'));
  hardFailures.push(...detectHardFailures(context));

  if (redactions.length > 0) {
    hardFailures.push({
      id: 'sensitive-content-detected',
      label: 'Sensitive content detected',
      reason: 'Secret-like or private content appeared in reward inputs; persistence/export is restricted.',
      evidence: redactions.map((redaction) => ({
        type: 'redaction',
        summary: `${redaction.type}: ${redaction.reason}`,
      })),
    });
  }

  for (const check of [...mandatoryChecks, ...optionalChecks]) {
    for (const item of check.evidence || []) evidence.push(item);
  }

  const score = computeScore({
    area,
    mandatoryChecks,
    optionalChecks,
    skippedChecks,
    hardFailures,
    classifier,
    handoff,
    redactions,
    changedFiles,
  });
  const verdict = computeVerdict({
    changedFiles,
    handoff,
    mandatoryChecks,
    optionalChecks,
    skippedChecks,
    hardFailures,
  });

  const exportEligibility = computeExportEligibility({ verdict, hardFailures, redactions });

  return {
    version: RUN_VERSION,
    policyVersion: POLICY_VERSION,
    runId,
    timestamp,
    agent: detectAgent(env),
    repo,
    area,
    changedFiles,
    classifier,
    signals,
    mandatoryChecks,
    optionalChecks,
    skippedChecks,
    hardFailures,
    score,
    verdict,
    evidence,
    redactions,
    exportEligibility,
  };
}

function getRepoInfo(cwd) {
  const name = path.basename(cwd);
  const branch = safeGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']) || 'unknown';
  const headSha = safeGit(cwd, ['rev-parse', '--short', 'HEAD']) || null;
  const dirty = (safeGit(cwd, ['status', '--porcelain']) || '').trim().length > 0;
  let baseRef = 'unknown';
  for (const candidate of ['origin/main', 'main', 'HEAD~1']) {
    const resolved = safeGit(cwd, ['rev-parse', '--verify', `${candidate}^{commit}`]);
    if (resolved) {
      baseRef = candidate;
      break;
    }
  }
  return { name, branch, baseRef, headSha, dirty };
}

function safeGit(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) return '';
  return (result.stdout || '').trim();
}

function collectChangedFiles(cwd, baseRef, changedFilesPath) {
  if (changedFilesPath) {
    const absolute = path.resolve(cwd, changedFilesPath);
    return uniqueLines(fs.readFileSync(absolute, 'utf8'));
  }

  const files = [];
  if (baseRef && baseRef !== 'unknown') {
    const diff = spawnSync('git', ['diff', '--name-only', `${baseRef}...HEAD`], { cwd, encoding: 'utf8' });
    if (diff.status === 0) files.push(...uniqueLines(diff.stdout || ''));
  }

  const status = spawnSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' });
  if (status.status === 0) {
    for (const line of String(status.stdout || '').split(/\r?\n/).filter(Boolean)) {
      const raw = line.slice(3).replace(/^"|"$/g, '');
      if (!raw) continue;
      if (raw.includes(' -> ')) {
        files.push(raw.split(' -> ')[0], raw.split(' -> ')[1]);
      } else {
        files.push(raw);
      }
    }
  }
  return [...new Set(files.filter(Boolean))].sort();
}

function uniqueLines(text) {
  return [...new Set(String(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean))];
}

function inferArea(changedFiles) {
  if (changedFiles.length === 0) return 'auto';
  if (changedFiles.some((file) => /(^|\/)(deploy|promote|release|rollback)|docs\/release\//.test(file))) return 'release';
  if (changedFiles.some((file) => /(^ios\/|Nexus Hub\/|\.swift$|Xcode|xcodeproj)/.test(file))) return 'ios';
  if (changedFiles.every((file) => /\.md$/.test(file) || file.startsWith('docs/') || file === 'AGENTS.md' || file === 'CLAUDE.md')) return 'docs';
  if (changedFiles.some((file) => /research|prompt-guidance|source|citations/i.test(file))) return 'research';
  return 'backend';
}

function runClassifier(cwd, changedFiles) {
  const commandParts = ['bash', 'scripts/changed-area-classifier.sh', '--json'];
  if (changedFiles.length > 0) commandParts.push('--files', changedFiles.join(','));
  const started = Date.now();
  const result = spawnSync(commandParts[0], commandParts.slice(1), {
    cwd,
    encoding: 'utf8',
    timeout: DEFAULT_TIMEOUT_MS,
    maxBuffer: 1024 * 1024 * 5,
  });
  const durationMs = Date.now() - started;
  let parsed = null;
  if (result.status === 0) {
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      parsed = null;
    }
  }
  return {
    command: commandParts.map(shellQuote).join(' '),
    versionHash: sha256File(path.join(cwd, 'scripts/changed-area-classifier.sh')),
    result: parsed || {
      error: result.error?.message || result.stderr || 'classifier failed or returned invalid JSON',
      stdout: bound(redactText(result.stdout || '').text),
      stderr: bound(redactText(result.stderr || '').text),
    },
    status: result.status === 0 && parsed ? 'PASS' : 'ERROR',
    exitCode: result.status,
    durationMs,
  };
}

function classifierCheck(classifier) {
  return {
    id: 'changed-area-classifier',
    label: 'Changed-area classifier',
    command: classifier.command,
    status: classifier.status === 'PASS' ? 'PASS' : 'ERROR',
    mandatory: true,
    exitCode: classifier.exitCode,
    durationMs: classifier.durationMs,
    evidence: [{
      type: 'command',
      summary: classifier.status === 'PASS' ? 'Classifier produced JSON' : 'Classifier failed or returned invalid JSON',
      command: classifier.command,
    }],
    verdictImpact: classifier.status === 'PASS' ? 'none' : 'manual_required',
    reason: classifier.status === 'PASS'
      ? 'Classifier mapped changed files to risk signals.'
      : 'Changed-area risk could not be classified deterministically.',
  };
}

function buildAreaChecks(context) {
  const checks = [];
  const { area, changedFiles, handoff, env } = context;
  const handoffText = handoff.content || '';
  const hasDocsChange = changedFiles.some((file) => /\.md$/.test(file) || file.startsWith('docs/') || file === 'AGENTS.md' || file === 'CLAUDE.md');

  if (hasDocsChange || area === 'docs' || area === 'release') {
    checks.push(runDocsAuditCheck(context));
  }

  if (handoff.path) checks.push(handoffSummaryCheck(handoff));
  else if (area !== 'auto') {
    checks.push(skippedCheck({
      id: 'handoff-summary',
      label: 'Handoff reward summary',
      command: 'read handoff',
      mandatory: false,
      verdictImpact: 'warn',
      skipClassification: 'warning',
      reason: 'No handoff path supplied; final answer must carry reward summary if no handoff is created.',
    }));
  }

  if (area === 'backend') {
    checks.push(backendEvidenceCheck(changedFiles, handoffText));
  }

  if (area === 'ios') {
    checks.push(iosEvidenceCheck(handoffText));
  }

  if (area === 'release') {
    checks.push(releaseEvidenceCheck(context, handoffText));
  }

  if (area === 'research') {
    checks.push(researchEvidenceCheck(handoffText));
  }

  if (env.NEXUS_REWARD_CHECK_VALIDATE_SCHEMA !== '0') {
    checks.push(schemaPresenceCheck(context.cwd));
  }

  return checks;
}

function buildOptionalChecks(context) {
  const checks = [];
  const handoffText = context.handoff.content || '';
  if (context.handoff.path && /\bL[1-5]\b/.test(handoffText)) {
    const claim = handoffText.match(/\bL[1-5]\b/)?.[0] || 'L1';
    checks.push(runCommandCheck({
      id: 'verify-deliverable',
      label: 'Delivered Means Verified handoff hygiene',
      cwd: context.cwd,
      command: 'node',
      args: ['scripts/verify-deliverable.mjs', '--claim', claim, '--handoff', context.handoff.path],
      mandatory: false,
      verdictImpactOnFailure: 'warn',
    }));
  } else if (context.handoff.path) {
    checks.push(skippedCheck({
      id: 'verify-deliverable',
      label: 'Delivered Means Verified handoff hygiene',
      command: 'node scripts/verify-deliverable.mjs --claim L1-L5 --handoff <path>',
      mandatory: false,
      verdictImpact: 'warn',
      skipClassification: 'warning',
      reason: 'Handoff does not declare an L1-L5 claim level; reward summary still checks evidence/verdict fields.',
    }));
  }
  return checks;
}

function runDocsAuditCheck(context) {
  if (context.env.NEXUS_REWARD_CHECK_SKIP_DOCS_AUDIT === '1') {
    return skippedCheck({
      id: 'docs-audit',
      label: 'Docs audit',
      command: 'npm run docs:audit',
      mandatory: true,
      verdictImpact: 'warn',
      skipClassification: 'warning',
      reason: 'Skipped by NEXUS_REWARD_CHECK_SKIP_DOCS_AUDIT=1 for test or local speed.',
    });
  }
  return runCommandCheck({
    id: 'docs-audit',
    label: 'Docs audit',
    cwd: context.cwd,
    command: 'npm',
    args: ['run', 'docs:audit'],
    mandatory: true,
    verdictImpactOnFailure: 'fail',
    timeoutMs: 120_000,
  });
}

function handoffSummaryCheck(handoff) {
  const content = handoff.content || '';
  const hasReward = /##\s+Verifiable Reward Summary/i.test(content);
  const hasVerdict = /\bVerdict\b/i.test(content);
  const hasEvidence = /\bEvidence\b/i.test(content);
  const hasSkipped = /\bSkipped checks?\b/i.test(content);
  const pass = hasReward && hasVerdict && hasEvidence && hasSkipped;
  return {
    id: 'handoff-reward-summary',
    label: 'Handoff reward summary',
    command: `read ${handoff.path}`,
    status: pass ? 'PASS' : 'FAIL',
    mandatory: true,
    exitCode: pass ? 0 : 1,
    durationMs: 0,
    evidence: [{
      type: 'file',
      path: handoff.path,
      summary: pass ? 'Handoff contains reward summary fields' : 'Handoff missing one or more reward summary fields',
    }],
    verdictImpact: pass ? 'none' : 'fail',
    reason: pass
      ? 'Handoff carries reward verdict, evidence, and skipped-check disclosure.'
      : 'Handoff must include the Verifiable Reward Summary block for non-trivial work.',
  };
}

function backendEvidenceCheck(changedFiles, handoffText) {
  const backendCodeChanged = changedFiles.some((file) => /^(src|scripts|migrations|__tests__)\/|package(-lock)?\.json$|tsconfig\.json$|vitest\.config\.ts$/.test(file));
  if (!backendCodeChanged) {
    return notApplicableCheck('backend-verification-evidence', 'Backend verification evidence', 'No backend-code/test/script files changed.');
  }
  const hasEvidence = /\b(npm run verify|npm run typecheck|risk-gate|vitest|pytest|migration-safety|docs:audit)\b/i.test(handoffText);
  if (hasEvidence) {
    return passEvidenceCheck('backend-verification-evidence', 'Backend verification evidence', 'Handoff names backend verification command evidence.');
  }
  return skippedCheck({
    id: 'backend-verification-evidence',
    label: 'Backend verification evidence',
    command: 'npm run verify or scripts/risk-gate.sh evidence',
    mandatory: true,
    verdictImpact: 'manual_required',
    skipClassification: 'manual review required',
    reason: 'Backend code/test/script files changed, but no handoff evidence was supplied for typecheck/tests/risk gate.',
  });
}

function iosEvidenceCheck(handoffText) {
  const hasEvidence = /\b(xcodebuild|XCTest|simulator|device|TestFlight|ios-single-simulator-test)\b/i.test(handoffText);
  if (hasEvidence) return passEvidenceCheck('ios-verification-evidence', 'iOS verification evidence', 'Handoff names iOS build/test or interaction evidence.');
  return skippedCheck({
    id: 'ios-verification-evidence',
    label: 'iOS verification evidence',
    command: 'xcodebuild build/test or documented simulator/device evidence',
    mandatory: true,
    verdictImpact: 'manual_required',
    skipClassification: 'manual review required',
    reason: 'iOS area selected without build/test/simulator/device evidence.',
  });
}

function releaseEvidenceCheck(context, handoffText) {
  if (context.releaseManifest) {
    const args = context.requireStaging ? [
      path.join(context.cwd, 'scripts/release-staging-attestation.mjs'),
      'validate',
      '--attestation', context.stagingAttestation || '.local/release/staging/missing.signed.json',
      '--manifest', context.releaseManifest,
      '--validate-release-manifest',
    ] : [
      path.join(context.cwd, 'scripts/release-manifest-v2.mjs'),
      'validate', '--manifest', context.releaseManifest,
    ];
    return runCommandCheck({
      id: 'release-verification-evidence',
      label: 'Artifact-bound release verification',
      cwd: context.cwd,
      command: process.execPath,
      args,
      mandatory: true,
      verdictImpactOnFailure: 'fail',
    });
  }
  const required = [
    ['release identity', /\brelease[- ]identity|release identity|version|sha\b/i],
    ['staging smoke', /\bstaging smoke\b/i],
    ['production health', /\bproduction health|\/health|PM2\b/i],
    ['authorization', /\bauthori[sz]ed|Felipe requested|owner approval\b/i],
  ];
  const missing = required.filter(([, regex]) => !regex.test(handoffText)).map(([label]) => label);
  if (missing.length === 0) {
    return passEvidenceCheck('release-verification-evidence', 'Release verification evidence', 'Handoff names required release evidence.');
  }
  return skippedCheck({
    id: 'release-verification-evidence',
    label: 'Release verification evidence',
    command: 'release identity + staging smoke + production health + authorization evidence',
    mandatory: true,
    verdictImpact: 'manual_required',
    skipClassification: 'manual review required',
    reason: `Release area missing evidence: ${missing.join(', ')}.`,
  });
}

function researchEvidenceCheck(handoffText) {
  const hasLinks = /https?:\/\//i.test(handoffText);
  const hasDates = /\b20\d{2}-\d{2}-\d{2}\b|\bobserved\b/i.test(handoffText);
  const hasUncertainty = /\bsource|citation|uncertain|unknown|not verified|official\b/i.test(handoffText);
  if (hasLinks && hasDates && hasUncertainty) {
    return passEvidenceCheck('research-source-evidence', 'Research source evidence', 'Handoff contains source links, date-awareness, and uncertainty/source language.');
  }
  return skippedCheck({
    id: 'research-source-evidence',
    label: 'Research source evidence',
    command: 'source/citation/date review',
    mandatory: true,
    verdictImpact: 'manual_required',
    skipClassification: 'manual review required',
    reason: 'Research area requires source links, observed dates/date-awareness, and uncertainty/source-quality language.',
  });
}

function schemaPresenceCheck(cwd) {
  const schemaPath = path.join(cwd, 'docs/agents/reward-run-schema.json');
  const exists = fs.existsSync(schemaPath);
  return {
    id: 'reward-schema-present',
    label: 'Reward schema present',
    command: 'test -f docs/agents/reward-run-schema.json',
    status: exists ? 'PASS' : 'FAIL',
    mandatory: true,
    exitCode: exists ? 0 : 1,
    durationMs: 0,
    evidence: [{ type: 'file', path: 'docs/agents/reward-run-schema.json', summary: exists ? 'Schema file exists' : 'Schema file missing' }],
    verdictImpact: exists ? 'none' : 'fail',
    reason: exists ? 'Schema file is present.' : 'Reward runs need a tracked schema.',
  };
}

function runCommandCheck({ id, label, cwd, command, args, mandatory, verdictImpactOnFailure, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const started = Date.now();
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024 * 5,
  });
  const durationMs = Date.now() - started;
  const redactedStdout = redactText(result.stdout || '');
  const redactedStderr = redactText(result.stderr || '');
  const status = result.error || result.status !== 0 ? 'FAIL' : 'PASS';
  return {
    id,
    label,
    command: [command, ...args].map(shellQuote).join(' '),
    status,
    mandatory,
    exitCode: result.status,
    durationMs,
    evidence: [{
      type: 'command',
      command: [command, ...args].map(shellQuote).join(' '),
      summary: status === 'PASS' ? 'Command passed' : 'Command failed',
      excerpt: bound([redactedStdout.text, redactedStderr.text].filter(Boolean).join('\n')),
    }],
    verdictImpact: status === 'PASS' ? 'none' : verdictImpactOnFailure,
    reason: status === 'PASS'
      ? `${label} passed.`
      : result.error?.message || `${label} failed with exit ${result.status}.`,
  };
}

function skippedCheck({ id, label, command, mandatory, verdictImpact, skipClassification, reason }) {
  return {
    id,
    label,
    command,
    status: 'SKIPPED',
    mandatory,
    exitCode: null,
    durationMs: 0,
    evidence: [{ type: 'skip', summary: reason }],
    verdictImpact,
    reason,
    skipClassification,
  };
}

function notApplicableCheck(id, label, reason) {
  return {
    id,
    label,
    command: '',
    status: 'NOT_APPLICABLE',
    mandatory: true,
    exitCode: null,
    durationMs: 0,
    evidence: [{ type: 'not_applicable', summary: reason }],
    verdictImpact: 'none',
    reason,
  };
}

function passEvidenceCheck(id, label, reason) {
  return {
    id,
    label,
    command: 'handoff evidence review',
    status: 'PASS',
    mandatory: true,
    exitCode: 0,
    durationMs: 0,
    evidence: [{ type: 'handoff', summary: reason }],
    verdictImpact: 'none',
    reason,
  };
}

function readHandoff(cwd, handoffPath) {
  if (!handoffPath) return { path: null, content: '' };
  const absolute = path.resolve(cwd, handoffPath);
  if (!fs.existsSync(absolute)) return { path: handoffPath, content: '', missing: true };
  return { path: handoffPath, content: fs.readFileSync(absolute, 'utf8') };
}

function detectHardFailures(context) {
  const failures = [];
  const allowedEnvironmentTemplates = new Set(['.env.example', '.env.local.example']);
  for (const file of context.changedFiles) {
    // Checked-in environment templates contain names/defaults only and are
    // the canonical place to document new rollout flags. Real `.env` variants
    // remain secret-bearing. Only the two canonical templates are exempt;
    // suffixes such as `.env.staging.example` may contain deploy secrets.
    if (/^\.env($|\.)/.test(file) && !allowedEnvironmentTemplates.has(file)) {
      failures.push({
        id: 'env-file-touched',
        label: 'Environment file touched',
        reason: `${file} is a secret-bearing path and must not be modified or exposed by agents.`,
        evidence: [{ type: 'path', path: file, summary: 'Secret-bearing path changed' }],
      });
    }
  }

  const handoffText = context.handoff.content || '';
  const unsafePatterns = [
    ['destructive-git', /\bgit\s+(reset\s+--hard|push\s+--force|rebase\b)/i, 'Unsafe destructive/shared git operation mentioned.'],
    ['no-verify', /\bgit\s+(commit|push)\b[^\n]*--no-verify\b/i, 'Bypassing hooks is prohibited without explicit approval.'],
    ['fabricated-evidence', /\b(fake|fabricat(?:e|ed|ing)|pretend(?:ed)?)\b[^\n]*(test|evidence|pass)/i, 'Fabricated evidence language detected.'],
    ['unsupported-tests-passed', /\btests? passed\b/i, 'Tests-passed claim requires command/evidence language.'],
  ];
  for (const [id, regex, reason] of unsafePatterns) {
    if (!regex.test(handoffText)) continue;
    if (id === 'unsupported-tests-passed' && /\b(npm|vitest|xcodebuild|pytest|command|evidence|log|run)\b/i.test(handoffText)) continue;
    failures.push({
      id,
      label: reason,
      reason,
      evidence: [{ type: 'handoff', path: context.handoff.path || '', summary: reason }],
    });
  }

  return failures;
}

export function computeVerdict({ changedFiles, handoff, mandatoryChecks, optionalChecks, skippedChecks, hardFailures }) {
  if (changedFiles.length === 0 && !handoff.path) return 'NOT_APPLICABLE';
  if (hardFailures.length > 0) return 'FAIL';
  if (mandatoryChecks.some((check) => ['FAIL', 'ERROR'].includes(check.status) && check.verdictImpact === 'fail')) return 'FAIL';
  if (skippedChecks.some((check) => check.skipClassification === 'hard failure' || check.verdictImpact === 'fail')) return 'FAIL';
  if (mandatoryChecks.some((check) => check.verdictImpact === 'manual_required')) return 'MANUAL_REQUIRED';
  if (skippedChecks.some((check) => check.skipClassification === 'manual review required' || check.verdictImpact === 'manual_required')) return 'MANUAL_REQUIRED';
  if ([...mandatoryChecks, ...optionalChecks].some((check) => check.verdictImpact === 'warn' || check.status === 'FAIL')) return 'WARN';
  if (skippedChecks.some((check) => check.skipClassification === 'warning')) return 'WARN';
  return 'PASS';
}

export function computeScore({ area, mandatoryChecks, optionalChecks, skippedChecks, hardFailures, classifier, handoff, redactions, changedFiles }) {
  let evidenceQuality = 35;
  let changedAreaCoverage = classifier.status === 'PASS' ? 20 : 5;
  let safety = hardFailures.length === 0 && redactions.length === 0 ? 20 : 0;
  let docsHygiene = 15;
  let handoffLoop = 10;

  const mandatoryProblemCount = mandatoryChecks.filter((check) => ['FAIL', 'ERROR', 'SKIPPED'].includes(check.status) && check.verdictImpact !== 'none').length;
  evidenceQuality = Math.max(0, evidenceQuality - mandatoryProblemCount * 12);

  const docsCheck = mandatoryChecks.find((check) => check.id === 'docs-audit');
  if (docsCheck) {
    if (docsCheck.status === 'PASS') docsHygiene = 15;
    else if (docsCheck.status === 'SKIPPED') docsHygiene = 8;
    else docsHygiene = 0;
  } else if (area !== 'docs' && area !== 'release' && !changedFiles.some((file) => file.endsWith('.md') || file.startsWith('docs/'))) {
    docsHygiene = 15;
  }

  const handoffCheck = mandatoryChecks.find((check) => check.id === 'handoff-reward-summary');
  if (handoff.path) handoffLoop = handoffCheck?.status === 'PASS' ? 10 : 0;
  else handoffLoop = 5;

  if (optionalChecks.some((check) => check.status === 'FAIL')) evidenceQuality = Math.max(0, evidenceQuality - 5);
  if (skippedChecks.some((check) => check.skipClassification === 'warning')) handoffLoop = Math.max(0, handoffLoop - 2);
  if (changedFiles.length === 0) changedAreaCoverage = 10;

  return Math.max(0, Math.min(100, Math.round(evidenceQuality + changedAreaCoverage + safety + docsHygiene + handoffLoop)));
}

function computeExportEligibility({ verdict, hardFailures, redactions }) {
  if (redactions.length > 0) return { eligible: false, reason: 'sensitive content detected; export blocked' };
  if (hardFailures.length > 0) return { eligible: false, reason: 'hard failures require review before export' };
  if (verdict === 'FAIL') return { eligible: false, reason: 'failed runs require manual review before export' };
  return { eligible: false, reason: 'manual human review required before export' };
}

function detectAgent(env) {
  const raw = (env.NEXUS_REWARD_AGENT || env.CLAUDECODE || env.CODEX_SESSION_ID || '').toLowerCase();
  let name = 'unknown';
  if (raw.includes('claude')) name = 'claude-code';
  else if (raw.includes('codex') || env.CODEX_SESSION_ID) name = 'codex';
  else if (raw.includes('human')) name = 'human';
  return {
    name,
    ...(env.CODEX_SESSION_ID ? { sessionId: env.CODEX_SESSION_ID } : {}),
    ...(env.NEXUS_REWARD_MODEL ? { model: env.NEXUS_REWARD_MODEL } : {}),
  };
}

function detectSensitiveContent(texts) {
  const patterns = [
    ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
    ['openai-key', /\bsk-[A-Za-z0-9_-]{20,}\b/g],
    ['env-secret', /\b(?:API_KEY|SECRET|TOKEN|PASSWORD|PRIVATE_KEY)\s*=\s*['"]?[^'"\s]{8,}/gi],
    ['oauth-token', /\b(?:access_token|refresh_token)\s*[:=]\s*['"]?[A-Za-z0-9._-]{20,}/gi],
  ];
  const redactions = [];
  const joined = texts.filter(Boolean).join('\n');
  for (const [type, pattern] of patterns) {
    const matches = joined.match(pattern);
    if (matches?.length) redactions.push({ type, reason: 'secret-like content detected', count: matches.length });
  }
  return redactions;
}

function redactText(text) {
  const redactions = [];
  let output = String(text);
  const replacements = [
    ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g],
    ['openai-key', /\bsk-[A-Za-z0-9_-]{20,}\b/g],
    ['env-secret', /\b(?:API_KEY|SECRET|TOKEN|PASSWORD|PRIVATE_KEY)\s*=\s*['"]?[^'"\s]{8,}/gi],
    ['oauth-token', /\b(?:access_token|refresh_token)\s*[:=]\s*['"]?[A-Za-z0-9._-]{20,}/gi],
  ];
  for (const [type, regex] of replacements) {
    let count = 0;
    output = output.replace(regex, () => {
      count += 1;
      return `[REDACTED:${type}]`;
    });
    if (count > 0) redactions.push({ type, reason: 'redacted from command output', count });
  }
  return { text: output, redactions };
}

function sha256File(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function shellQuote(value) {
  if (/^[A-Za-z0-9_./:=@-]+$/.test(value)) return value;
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function bound(text) {
  const value = String(text || '');
  if (value.length <= BOUNDED_OUTPUT_CHARS) return value;
  return `${value.slice(0, BOUNDED_OUTPUT_CHARS)}\n[truncated ${value.length - BOUNDED_OUTPUT_CHARS} chars]`;
}

export function formatHumanSummary(run) {
  const hardFailures = run.hardFailures.length === 0
    ? 'none'
    : run.hardFailures.map((failure) => failure.id).join(', ');
  const mandatory = summarizeChecks(run.mandatoryChecks);
  const skipped = run.skippedChecks.length === 0
    ? 'none'
    : run.skippedChecks.map((check) => `${check.id}: ${check.skipClassification || check.verdictImpact}`).join('; ');

  return [
    'Nexus Verifiable Reward Loop',
    `Verdict: ${run.verdict}`,
    `Score: ${run.score}`,
    `Area: ${run.area}`,
    `Hard failures: ${hardFailures}`,
    `Mandatory checks: ${mandatory}`,
    `Skipped checks: ${skipped}`,
    `Export eligibility: ${run.exportEligibility.eligible ? 'eligible' : 'ineligible'} - ${run.exportEligibility.reason}`,
  ].join('\n');
}

function summarizeChecks(checks) {
  const counts = checks.reduce((acc, check) => {
    acc[check.status] = (acc[check.status] || 0) + 1;
    return acc;
  }, {});
  return Object.entries(counts).map(([status, count]) => `${status} ${count}`).join(', ') || 'none';
}

export function writeRun(run, outputPath, cwd = process.cwd()) {
  const destination = outputPath
    ? path.resolve(cwd, outputPath)
    : path.join(cwd, process.env.NEXUS_REWARD_RUN_DIR || '.local/reward-runs', `${run.timestamp.replace(/[:.]/g, '-')}-${run.runId}.json`);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, `${JSON.stringify(run, null, 2)}\n`);
  return destination;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[reward-check] ${error.message}`);
    console.error(usage());
    process.exit(64);
  }

  if (args.help) {
    console.log(usage());
    return;
  }

  const run = buildRewardRun({
    area: args.area,
    handoff: args.handoff,
    changedFilesPath: args.changedFilesPath,
    releaseManifest: args.releaseManifest,
    stagingAttestation: args.stagingAttestation,
    requireStaging: args.requireStaging,
  });
  const outputPath = writeRun(run, args.output);

  if (args.json) {
    console.log(JSON.stringify({ outputPath, ...run }, null, 2));
  } else {
    console.log(formatHumanSummary(run));
    console.log(`Raw run: ${outputPath}`);
  }

  if (args.enforce && ['FAIL', 'MANUAL_REQUIRED'].includes(run.verdict)) process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[reward-check] ${error.stack || error.message}`);
    process.exit(1);
  });
}
