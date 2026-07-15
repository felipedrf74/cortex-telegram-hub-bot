#!/usr/bin/env node
// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CANNOT_SKIP_GATE_NAMES,
  classifyChangedFiles,
} from './lib/changed-area-classifier.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const cannotSkipGateFixtures = [
  ['tenant-auth-security', 'src/api/routes/auth.ts', '__tests__/api/auth-'],
  ['memory-retrieval-isolation', 'src/services/context-engine.ts', 'context'],
  ['prompt-injection-defense', 'prompts/secretary.md', '__tests__/security/'],
  ['calendar-agenda-lifecycle', 'src/services/unified-calendar.ts', 'calendar'],
  ['provider-routing-fallback', 'src/services/provider-registry.ts', 'provider-'],
  ['migration-rollback-review', 'migrations/082_example.sql', 'MIGRATION'],
  ['irreversible-migration-manual-approval', 'migrations/200_content_radar_phase0_rollout_guards.sql', 'IRREVERSIBLE_MIGRATION'],
  ['deploy-script-promotion-rehearsal', 'scripts/deploy.sh', 'DEPLOY'],
  ['hook-validation-on-feature-branch', '.husky/pre-commit', 'HOOK'],
  ['ci-workflow-validation-on-PR', '.github/workflows/ci.yml', 'CI'],
  ['test-config-mock-completeness-audit', 'vitest.config.ts', 'TEST_CONFIG'],
  ['test-infrastructure-full-suite', 'config/test-policy.json', 'FULL'],
  ['unresolved-change-impact-full-verification', 'docs/unresolved-impact.md', 'FULL', { impactResolved: false }],
  ['attachment-tenant-isolation', 'src/api/routes/chat-message-attachments.ts', 'chat-attachments'],
  ['model-routing-cost-attribution', 'src/services/domain-provider-router.ts', 'domain-provider-router'],
  ['personalization-scope-isolation', 'src/services/cooking-preferences.ts', 'cooking-preferences'],
  ['content-agent-neutrality', 'src/agents/reaction-radar-agent.ts', 'content-agent-neutrality'],
  ['logger-redaction-pii-scan', 'src/utils/logger.ts', 'logger-'],
  ['scheduler-tenant-scope-and-failure', 'src/services/scheduler.ts', 'scheduler-'],
  ['notification-apns-delivery-and-tenant', 'src/services/notification-orchestrator.ts', 'notification-'],
  ['health-integration-tenant-isolation', 'src/services/garmin.ts', 'garmin-'],
  ['auth-rate-limit-and-lockout', 'src/api/middleware/rate-limit.ts', 'rate-limiter'],
  ['audit-trail-emission-and-scope', 'src/services/audit-trail.ts', 'audit-trail'],
  ['deploy-config-health-rehearsal', 'ecosystem.config.js', 'config-'],
  ['event-backbone-jobs-sync-tenant-isolation', 'src/services/event-outbox.ts', 'event-backbone'],
  ['ios-navigation-responsiveness', 'Nexus Hub/Views/MainTabView.swift', 'NavigationPerformance'],
  ['ios-contract-decoder-resilience', 'Nexus Hub/Core/Services/TrainingService.swift', 'ContractDecoder'],
  ['ios-notification-decision-center', 'Nexus Hub/Core/NotificationManager.swift', 'NotificationManager'],
  ['apple-notifications-jws-verify', 'src/services/apple-jws-verifier.ts', 'apple-notifications-jws-verify'],
  ['training-routes-entitlement', 'src/api/routes/training.ts', 'training-routes-entitlement'],
  ['training-plan-create-e2e', 'src/services/training-plan-volume-enforcement.ts', 'training-plan-create-cycle'],
  ['content-engine-prompt-cleanliness', 'content-engine/services/creative/hook_generator.py', 'test_prompt_cleanliness'],
  ['voice-evolution-multi-tenant', 'src/agents/voice-evolution-agent.ts', 'voice-evolution-multi-tenant'],
  ['video-study-prompt-cleanliness', 'src/services/video-study.ts', 'video-study-prompt-cleanliness'],
  ['channel-learner-prompt-cleanliness', 'src/services/channel-learner.ts', 'channel-learner-prompt-cleanliness'],
  ['cost-guardrail-global-rest', 'src/services/cost-guardrail.ts', 'cost-guardrail-global-rest'],
  ['cache-coherence-registry', 'src/services/cache-coherence-registry.ts', 'cache-coherence-registry'],
  ['cached-route-handler', 'src/api/route-helpers/cached-route-handler.ts', 'cached-route-handler'],
  ['garmin-tenant-leak-and-apple-health-cascade', 'src/services/readiness-scorer.ts', 'garmin-tenant-leak-and-apple-health-cascade'],
  ['google-drive-tenant-leak', 'src/services/google-drive.ts', 'google-drive-tenant-leak'],
  ['registry-real-eval-quality-gates', 'src/services/chat/registry/index.ts', 'registry-real-eval-gates'],
  ['science-policy-version-check', 'src/services/coach-kernel/knowledge/entities/training-principles.json', 'coach-kernel-'],
];

const sentinels = new Set(['MIGRATION', 'IRREVERSIBLE_MIGRATION', 'DEPLOY', 'HOOK', 'CI', 'TEST_CONFIG']);

export function assertCannotSkipFixtureCoverage() {
  const registered = new Set(CANNOT_SKIP_GATE_NAMES);
  const fixtureNames = cannotSkipGateFixtures.map(([gate]) => gate);
  const fixtures = new Set(fixtureNames);
  const missing = CANNOT_SKIP_GATE_NAMES.filter((gate) => !fixtures.has(gate));
  const unknown = fixtureNames.filter((gate) => !registered.has(gate));
  const duplicates = fixtureNames.filter((gate, index) => fixtureNames.indexOf(gate) !== index);
  if (missing.length > 0 || unknown.length > 0 || duplicates.length > 0) {
    throw new Error(`Cannot-skip fixture registry mismatch: missing=${missing.join(',') || 'none'}; unknown=${unknown.join(',') || 'none'}; duplicates=${duplicates.join(',') || 'none'}`);
  }
}

function parseArgs(argv) {
  const options = { format: 'markdown', writeEvidence: true, quiet: false, baseRef: 'explicit-files' };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') options.format = 'json';
    else if (argument === '--markdown') options.format = 'markdown';
    else if (argument === '--no-evidence') options.writeEvidence = false;
    else if (argument === '--quiet') options.quiet = true;
    else if (argument === '--base') options.baseRef = argv[++index] ?? 'explicit-files';
    else if (argument === '-h' || argument === '--help') {
      process.stdout.write('cannot-skip-gate-dashboard [--json|--markdown] [--no-evidence] [--quiet] [--base ref]\n');
      process.exit(0);
    } else {
      process.stderr.write(`Unknown arg: ${argument}\n`);
      process.exit(2);
    }
  }
  return options;
}

function compactTimestamp(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');
}

export function buildCannotSkipDashboard({
  baseRef = 'explicit-files',
  now = new Date(),
} = {}) {
  assertCannotSkipFixtureCoverage();
  const gates = cannotSkipGateFixtures.map(([gate, representativeFile, expected, classifyOptions = {}]) => {
    const data = classifyChangedFiles({
      files: [representativeFile],
      root,
      baseRef,
      generatedAt: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
      ...classifyOptions,
    });
    const routes = [...data.vitest.globs, ...data.pytest.globs, ...data.xctest.classes];
    const cannotSkipFires = data.cannotSkip.includes(gate);
    const expectedTestRouteFires = expected === 'FULL'
      ? data.vitest.mode === 'full'
      : sentinels.has(expected)
      || routes.some((route) => route.includes(expected));
    return {
      gate,
      representativeFile,
      cannotSkipFires,
      expectedTestRouteFires,
      pass: cannotSkipFires && expectedTestRouteFires,
      vitestGlobs: data.vitest.globs,
      xctestClasses: data.xctest.classes,
    };
  });
  const failedGates = gates.filter((gate) => !gate.pass)
    .map((gate) => `${gate.gate} (representative=${gate.representativeFile})`);
  const pass = gates.length - failedGates.length;
  return {
    summary: {
      generatedAt: now.toISOString(),
      runIdentifier: compactTimestamp(now),
      total: gates.length,
      pass,
      fail: failedGates.length,
      verdict: failedGates.length === 0 ? 'PASS' : 'FAIL',
      failedGates,
    },
    gates,
  };
}

function formatMarkdown(payload, evidencePath) {
  const lines = [
    '# Cannot-skip gate dashboard',
    '',
    `- Generated at: ${payload.summary.generatedAt}`,
    `- Total gates checked: ${payload.summary.total}`,
    `- Pass: ${payload.summary.pass}`,
    `- Fail: ${payload.summary.fail}`,
  ];
  if (evidencePath) lines.push(`- Evidence: ${evidencePath}`);
  lines.push('', payload.summary.fail === 0
    ? '**Verdict: PASS** — every cannot-skip gate fires on its representative file.'
    : `**Verdict: FAIL** — ${payload.summary.fail} gate(s) did not fire correctly:`);
  if (payload.summary.fail > 0) lines.push(...payload.summary.failedGates.map((gate) => `- ${gate}`));
  lines.push('', '## Per-gate detail', '', '| Gate | Representative file | cannotSkip fires | test route fires |', '|---|---|:---:|:---:|');
  for (const gate of payload.gates) {
    lines.push(`| \`${gate.gate}\` | \`${gate.representativeFile}\` | ${gate.cannotSkipFires ? '✓' : '✗'} | ${gate.expectedTestRouteFires ? '✓' : '✗'} |`);
  }
  return `${lines.join('\n')}\n`;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const payload = buildCannotSkipDashboard({ baseRef: options.baseRef });
  let relativeEvidencePath = null;
  if (options.writeEvidence) {
    relativeEvidencePath = `.local/release/cannot-skip-gate-evidence/cannot-skip-gate-${payload.summary.runIdentifier}.json`;
    const evidencePath = path.join(root, relativeEvidencePath);
    fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
    fs.writeFileSync(evidencePath, `${JSON.stringify(payload, null, 2)}\n`);
  }
  if (options.format === 'json') process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else if (!options.quiet) process.stdout.write(formatMarkdown(payload, relativeEvidencePath));
  if (payload.summary.fail > 0) process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
