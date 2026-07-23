// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import fs from 'node:fs';
import path from 'node:path';
import {
  irreversibleMigrationReason,
  loadIrreversibleMigrationPolicy,
} from './irreversible-migration-policy.mjs';
import { migrationSafetyGovernanceReasons } from './migration-safety-policy-classifier.mjs';

const BOOTSTRAP_FULL_SUITE_PATHS = new Set([
  'config/test-policy.json',
  'config/irreversible-migrations.json',
  'config/production-migration-lineages.json',
  'scripts/changed-area-classifier.sh',
  'scripts/changed-area-classifier.mjs',
  'scripts/resolve-ci-change-base.sh',
  'scripts/lib/changed-area-classifier.mjs',
  'scripts/lib/git-changed-paths.mjs',
  'scripts/lib/irreversible-migration-policy.mjs',
  'scripts/lib/migration-safety-policy-classifier.mjs',
  'scripts/lib/production-migration-lineage.mjs',
  'scripts/lib/production-shape-migration-rehearsal-evidence.mjs',
  'scripts/lib/test-policy.mjs',
  'scripts/migration-safety-check.mjs',
  'scripts/production-shape-migration-rehearsal.mjs',
  'scripts/validate-production-shape-migration-rehearsal.mjs',
  'scripts/release-test-gate.sh',
  'scripts/release-verify.sh',
  'scripts/protected-main-ci-evidence.mjs',
]);

const MIGRATION_POLICY_GOVERNANCE_PATHS = new Set(migrationSafetyGovernanceReasons.keys());

export const CANNOT_SKIP_GATE_NAMES = Object.freeze([
  'tenant-auth-security',
  'memory-retrieval-isolation',
  'prompt-injection-defense',
  'calendar-agenda-lifecycle',
  'provider-routing-fallback',
  'migration-rollback-review',
  'irreversible-migration-manual-approval',
  'science-policy-version-check',
  'exact-release-promotion-rehearsal',
  'hook-validation-on-feature-branch',
  'ci-workflow-validation-on-PR',
  'test-config-mock-completeness-audit',
  'test-infrastructure-full-suite',
  'unresolved-change-impact-full-verification',
  'attachment-tenant-isolation',
  'model-routing-cost-attribution',
  'personalization-scope-isolation',
  'content-agent-neutrality',
  'logger-redaction-pii-scan',
  'scheduler-tenant-scope-and-failure',
  'notification-apns-delivery-and-tenant',
  'health-integration-tenant-isolation',
  'auth-rate-limit-and-lockout',
  'audit-trail-emission-and-scope',
  'deploy-config-health-rehearsal',
  'event-backbone-jobs-sync-tenant-isolation',
  'ios-navigation-responsiveness',
  'ios-contract-decoder-resilience',
  'ios-notification-decision-center',
  'apple-notifications-jws-verify',
  'training-routes-entitlement',
  'training-plan-create-e2e',
  'content-engine-prompt-cleanliness',
  'voice-evolution-multi-tenant',
  'video-study-prompt-cleanliness',
  'channel-learner-prompt-cleanliness',
  'cost-guardrail-global-rest',
  'cache-coherence-registry',
  'cached-route-handler',
  'garmin-tenant-leak-and-apple-health-cascade',
  'google-drive-tenant-leak',
  'registry-real-eval-quality-gates',
]);

const cannotSkipGateNameSet = new Set(CANNOT_SKIP_GATE_NAMES);

export function globToRegExp(glob) {
  let source = '';
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index];
    const next = glob[index + 1];
    if (character === '*' && next === '*') {
      if (glob[index + 2] === '/') {
        source += '(?:.*/)?';
        index += 2;
      } else {
        source += '.*';
        index += 1;
      }
    } else if (character === '*') {
      source += '[^/]*';
    } else if (character === '?') {
      source += '[^/]';
    } else {
      source += character.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}

export function normalizeChangedFiles(inputFiles) {
  const normalized = [];
  for (const rawFile of inputFiles) {
    if (!rawFile) continue;
    const renameParts = rawFile.includes(' -> ')
      ? [rawFile.slice(0, rawFile.indexOf(' -> ')), rawFile.slice(rawFile.lastIndexOf(' -> ') + 4)]
      : [rawFile];
    for (const renamePart of renameParts) {
      const file = renamePart
        .replace(/^\.\//, '')
        .replace(/^(?:engine|backend|cortex-telegram-hub-bot)\//, '');
      if (file) normalized.push(file);
    }
  }
  return [...new Set(normalized)].sort();
}

function matches(files, pattern) {
  const regex = pattern instanceof RegExp ? pattern : new RegExp(pattern);
  return files.some((file) => regex.test(file));
}

function dedupe(values) {
  return [...new Set(values.filter(Boolean))];
}

function loadFullSuiteTriggers(root, policyPath) {
  const policy = JSON.parse(fs.readFileSync(
    policyPath ?? path.join(root, 'config/test-policy.json'),
    'utf8',
  ));
  if (!Array.isArray(policy.fullSuiteTriggers)) {
    throw new Error('fullSuiteTriggers is missing');
  }
  return policy.fullSuiteTriggers;
}

function isIrreversibleMigration(files, root, fileExists, readText, policyPath) {
  const policy = loadIrreversibleMigrationPolicy({
    root,
    policyPath,
    fileExists,
    readText,
  });
  if (policy.integrityIssues.length > 0) return true;
  for (const file of files) {
    if (!/^migrations\/.*\.sql$/.test(file)) continue;
    const absolute = path.join(root, file);
    if (!fileExists(absolute)) return true;
    // A rollback migration is expected to contain destructive SQL. Its
    // contents must not make an additive forward migration irreversible; a
    // deleted or renamed rollback still fails closed through the check above.
    if (/^migrations\/down\//.test(file)) continue;
    if (irreversibleMigrationReason(file, readText(absolute), policy)) {
      return true;
    }
  }
  return false;
}

/**
 * Classify a normalized set of changed paths without invoking Git or a shell.
 * Filesystem readers are injectable so tests can stay deterministic while the
 * CLI can still fail closed for deleted/renamed migration files.
 */
export function classifyChangedFiles({
  files: rawFiles,
  root,
  baseRef = 'explicit-files',
  head = 'unknown',
  impactResolved = true,
  testTopologyChanged = false,
  generatedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  fullSuiteTriggers,
  policyPath,
  irreversiblePolicyPath = path.join(root, 'config/irreversible-migrations.json'),
  fileExists = fs.existsSync,
  readText = (file) => fs.readFileSync(file),
} = {}) {
  if (!root) throw new Error('classifyChangedFiles requires root');
  const files = normalizeChangedFiles(rawFiles ?? []);
  const has = (pattern) => matches(files, pattern);
  const flags = {
    backendSrc: false,
    backendTest: false,
    apiRoute: false,
    training: false,
    coachKernel: false,
    calendar: false,
    providerRouting: false,
    authOrTenant: false,
    memoryOrRetrieval: false,
    prompt: false,
    cooking: false,
    content: false,
    finance: false,
    secretary: false,
    portal: false,
    migration: false,
    pythonEngine: false,
    iosSrc: false,
    iosAuth: false,
    iosTest: false,
    iosUi: false,
    releaseOperator: false,
    hook: false,
    ciWorkflow: false,
    testConfig: false,
    packageJson: false,
    highFanIn: false,
    fullSuiteTrigger: false,
    testTopologyChange: Boolean(testTopologyChanged),
    impactResolved,
    irreversibleMigration: false,
    currentVerdictDoc: false,
    attachment: false,
    chatReasoning: false,
    chatCoreV2: false,
    modelRouting: false,
    personalizationScope: false,
    contentAgent: false,
    logger: false,
    scheduler: false,
    notification: false,
    eventBackbone: false,
    healthIntegration: false,
    rateLimit: false,
    audit: false,
    deployConfig: false,
    runtimeInfra: false,
    operationsTooling: false,
    iosNavigation: false,
    iosDto: false,
    appleNotificationWebhook: false,
    trainingEntitlement: false,
    contentPromptCleanliness: false,
  };
  let docsOnly = true;
  let nonDoc = false;
  let sciencePolicyJson = false;
  let iosNotification = false;
  let voiceEvolutionMultiTenant = false;
  let videoStudyPromptCleanliness = false;
  let channelLearnerPromptCleanliness = false;
  let globalCostGuardrailRest = false;
  let cacheCoherenceRegistry = false;
  let cachedRouteHandler = false;
  let garminAppleHealthCascade = false;
  let googleDriveTenantLeak = false;
  let registryRealEval = false;

  if (files.some((file) => !(/\.md$/.test(file) || /^docs\//.test(file) || /\/docs\//.test(file)
    || file === 'CHANGELOG.md' || /^prompts\/.*\.md$/.test(file)))) {
    nonDoc = true;
    docsOnly = false;
  }
  if (!impactResolved) {
    nonDoc = true;
    docsOnly = false;
    flags.migration = true;
    flags.pythonEngine = true;
  }

  flags.currentVerdictDoc = has(/^docs\/release\/(?:release-state\.json|CURRENT_RELEASE_STATE\.md)$/)
    || has(/^engine\/docs\/release\/release-state\.json$/);
  flags.backendSrc = has(/^src\//);
  flags.backendTest = has(/^__tests__\//);
  flags.apiRoute = has(/^src\/api\//);

  if (has(/^src\/services\/coach-kernel\//)) {
    flags.training = true;
    flags.coachKernel = true;
  }
  flags.training ||= has(/^src\/services\/training-|^src\/api\/routes\/training/);
  flags.trainingEntitlement = has(/^src\/api\/routes\/training|^src\/api\/router\.ts$|^__tests__\/security\/training-routes-entitlement\.test\.ts$/);
  flags.training ||= has(/^src\/skills\/training\//);
  flags.training ||= has(/^__tests__\/services\/training-/);
  if (has(/^__tests__\/services\/coach-kernel-/)) {
    flags.training = true;
    flags.coachKernel = true;
  }
  flags.training ||= has(/^__tests__\/api\/training-/);

  flags.calendar = has(/^src\/services\/(?:unified-calendar|calendar)/)
    || has(/^__tests__\/services\/.*calendar/)
    || has(/^__tests__\/api\/training-calendar-/)
    || has(/^__tests__\/api\/training-plan-calendar-/);
  flags.providerRouting = has(/^src\/services\/(?:provider-registry|gemini-provider|anthropic|tool-executor|openai)/)
    || has(/^__tests__\/services\/(?:provider-|ai-provider)/);
  flags.authOrTenant = has(/^src\/(?:api\/middleware\/auth|api\/routes\/auth|services\/auth|services\/ios-auth-session|services\/google-sign-in|services\/apple-sign-in-nonce|services\/google-auth-session-store|services\/oauth(?:-flow|-state-store|-store)|portal\/oauth-routes|services\/user-service|state\/scope)/)
    || has(/^__tests__\/(?:security\/|scope\/|api\/auth-|api\/connections-tenant-|services\/google-sign-in|services\/apple-sign-in-nonce|services\/oauth-|portal\/portal-oauth-routes)/);
  flags.memoryOrRetrieval = has(/^src\/(?:services\/context-engine|services\/chat-context-engine|state\/content-references|services\/intelligence-bus)/)
    || has(/^__tests__\/services\/.*(?:context|memory|retrieval)/);
  flags.prompt = has(/^prompts\/|^src\/skills\/.*\/prompts\//);
  flags.cooking = has(/^src\/(?:domains\/cooking|services\/cooking-|services\/skills\/cooking\/|api\/routes\/cooking|skills\/cooking\/)/)
    || (has(/cooking/) && has(/^__tests__\//));
  flags.content = has(/^src\/(?:domains\/content\/|services\/content-|services\/voice-|api\/routes\/content|agents\/)|^content-engine\//)
    || has(/^__tests__\/services\/content-/);
  flags.contentPromptCleanliness = has(/^content-engine\/(?:services\/|models\/|routers\/|tests\/test_prompt_cleanliness\.py$)/)
    || has(/^src\/services\/content-engine\.ts$|^src\/commands\/books\.ts$/);
  flags.contentAgent = has(/^src\/agents\/|^src\/services\/cross-agent-learning(?:\.ts|\/)|^__tests__\/services\/cross-agent-learning|^__tests__\/security\/content-agent-neutrality/);
  voiceEvolutionMultiTenant = has(/^src\/agents\/voice-evolution-agent\.ts$|^__tests__\/agents\/voice-evolution-multi-tenant\.test\.ts$/);
  videoStudyPromptCleanliness = has(/^src\/services\/video-study\.ts$|^__tests__\/services\/video-study-prompt-cleanliness\.test\.ts$/);
  channelLearnerPromptCleanliness = has(/^src\/services\/channel-learner\.ts$|^__tests__\/services\/channel-learner-prompt-cleanliness\.test\.ts$/);
  flags.finance = has(/^src\/(?:domains\/finance\/|services\/finance-|services\/invoice-|api\/routes\/finance|skills\/finance\/)/)
    || has(/^__tests__\/services\/(?:finance-|invoice-)/);
  flags.secretary = has(/^src\/(?:domains\/secretary\/|services\/secretary-|api\/routes\/secretary|skills\/secretary\/)/)
    || has(/^__tests__\/services\/secretary-/);
  flags.portal = has(/^src\/portal\/|^__tests__\/portal\/|^scripts\/cooking-portal-browser-smoke\.ts$/);
  const irreversiblePolicyChanged = files.some((file) => MIGRATION_POLICY_GOVERNANCE_PATHS.has(file));
  flags.migration ||= has(/^migrations\//) || irreversiblePolicyChanged;
  sciencePolicyJson = has(/^src\/services\/coach-kernel\/knowledge\/entities\/(?:training-principles\.json|\.science-policy-hash)$/)
    || has(/^scripts\/ci\/science-policy-version-check\.mjs$/);
  flags.pythonEngine ||= has(/^content-engine\//);
  flags.appleNotificationWebhook = has(/^src\/api\/router\.ts$|^src\/api\/routes\/billing\.ts$|^src\/services\/apple-jws-verifier\.ts$|^__tests__\/security\/billing-apple-notifications-jws-verify\.test\.ts$/);
  globalCostGuardrailRest = has(/^src\/services\/cost-guardrail\.ts$|^src\/api\/routes\/(?:chat-message-request|training-plan-routes|training|content-script-routes|finance)\.ts$|^__tests__\/security\/cost-guardrail-global-rest\.test\.ts$/);
  cacheCoherenceRegistry = has(/^src\/services\/cache-coherence-registry\.ts$|^__tests__\/services\/cache-coherence-registry\.test\.ts$/);
  cachedRouteHandler = has(/^src\/api\/route-helpers\/(?:cached-route-handler|provider-error-classifier)\.ts$|^src\/api\/routes\/(?:calendar|content|dashboard|notifications|plan|tasks)\.ts$|^__tests__\/api\/cached-route-handler\.test\.ts$/);
  garminAppleHealthCascade = has(/^src\/services\/(?:garmin|garmin-session-store|readiness-scorer)\.ts$|^src\/services\/wearable\/(?:wearable-service|apple-health-adapter|types)\.ts$|^src\/api\/routes\/(?:dashboard-data-fetchers|health-data)\.ts$|^__tests__\/security\/garmin-tenant-leak-and-apple-health-cascade\.test\.ts$/);
  googleDriveTenantLeak = has(/^src\/services\/(?:google-drive|google-auth)\.ts$|^__tests__\/security\/google-drive-tenant-leak\.test\.ts$|^scripts\/cleanup-tainted-google-drive-sessions\.mjs$/);
  registryRealEval = has(/^src\/services\/chat\/registry\/|^src\/services\/registry-(?:driven-eval-scenarios|real-eval-scoring|telemetry-report|adversarial-discovery|adversarial-example-proposer|readable-intents-proposer|cross-tenant-alert-hook)\.ts$|^src\/services\/build-llm-safe-prompt-slice\.ts$|^src\/services\/skills\/|^__tests__\/services\/(?:chat-action-registry-|registry-(?:driven-eval|real-eval|telemetry-report|adversarial|readable-intents|cross-tenant))|^__tests__\/scripts\/registry-feedback-report\.test\.ts$|^scripts\/registry-feedback-report\.ts$/);

  flags.releaseOperator = has(/^config\/production-migration-lineages\.json$/)
    || has(/^scripts\/(?:release-operator|promote-exact-release|build-release-runtime-dependencies|env-parity-check|remote-release-preflight|remote-release-readiness|remote-prepare-release-backup|remote-create-release-backup|remote-production-shape-migration-rehearsal|remote-start-sanitized-pm2|remote-promotion-(?:control|systemd-install|transaction)|remote-release-capacity|rollback|restore)\.sh$/)
    || has(/^scripts\/(?:release-artifact-manifest|release-bundle|release-manifest-v2|release-plan-evaluator|release-runtime-dependencies|release-sequence|trusted-release-signer|protected-main-ci-evidence|complete-promotion-migration-gate|production-shape-migration-rehearsal|validate-production-shape-migration-rehearsal)\.mjs$/)
    || has(/^scripts\/systemd\/nexus-release-promotion/)
    || has(/^scripts\/lib\/(?:release-artifact-manifest|release-plan-evaluation|production-migration-lineage|production-shape-migration-rehearsal-evidence)\.mjs$/);
  flags.operationsTooling = has(/^ops\/(?:sonarqube|application-dr|ollama)\//)
    || has(/^scripts\/(?:(?:quality-sonar|application-dr)-|ollama-(?:large-model-cleanup|observation-collector|service-envelope-check|soak-evidence|zero-swap-transition))/)
    || has(/^scripts\/lib\/ollama-service-envelope\.mjs$/)
    || has(/^__tests__\/scripts\/(?:quality-sonar|application-disaster-recovery|ollama-(?:large-model-cleanup|observation-collector|systemd-envelope))\.test\.ts$/);
  if (has(/^scripts\/lib\/release-gates\.sh$/)) {
    flags.runtimeInfra = true;
    flags.deployConfig = true;
  }
  if (has(/^Dockerfile(?:\..*)?$|^docker-compose(?:\..*)?\.ya?ml$|^\.dockerignore$|^\.nvmrc$|^\.node-version$|^\.env(?:\..*)?\.example$|^\.env\.example$|^content-engine\/Dockerfile(?:\..*)?$|^content-engine\/\.env(?:\..*)?\.example$/)) {
    flags.runtimeInfra = true;
    flags.deployConfig = true;
  }
  flags.hook = has(/^\.husky\//);
  flags.ciWorkflow = has(/^\.github\/workflows\//);
  flags.testConfig = has(/^(?:vitest\.config\.ts|tsconfig\.json)$/);
  flags.packageJson = has(/^(?:package\.json|package-lock\.json)$/);
  flags.highFanIn = has(/^src\/(?:config|index)\.ts$|^src\/services\/(?:database|db|tenant-scope)\.ts$|^src\/api\/router\.ts$/);

  flags.attachment = has(/^src\/api\/routes\/chat-message-attachments|^src\/api\/routes\/chat-attachments|^__tests__\/api\/chat-attachments|^__tests__\/api\/chat-message-attachments|^__tests__\/services\/fiscal-bundle-attachments/);
  flags.modelRouting = has(/^src\/services\/(?:domain-provider-router|ollama-model-policy|ollama-provider|model-config)|^src\/portal\/provider-routes|^__tests__\/services\/(?:domain-provider-router|model-routing-|ollama-small-only-policy|ollama-provider|model-config)/);
  flags.personalizationScope = has(/^src\/services\/(?:cooking-preferences|finance-preferences|skill-memory)|^src\/state\/content-references|^__tests__\/services\/(?:cooking-preferences|finance-preferences|skill-memory|content-references)/);
  flags.logger = has(/^src\/utils\/(?:logger|redact|log-context)|^__tests__\/utils\/logger-|^__tests__\/api\/secret-guards/);
  flags.scheduler = has(
    /^src\/services\/(?:scheduler|scheduled-agent-jobs|agent-job-(?:runner|targets|manifest)|background-job-queue|chat-action-fixer-worker|channel-learner|garmin-coach|cron|job-)|^src\/agents\/voice-evolution-agent\.ts$|^__tests__\/services\/(?:scheduler-|agent-job-runner|scheduled-agent-job-governance)/,
  );
  flags.notification = has(/^src\/services\/(?:apns-|notification|decision-center|content-notification)|^src\/api\/routes\/(?:notifications|decisions|content-notification)|^__tests__\/(?:services\/apns-|services\/notification-|services\/decision-center|services\/content-notifications|api\/notifications-|api\/decisions-routes|api\/content-notification-|security\/notification-)/);
  flags.healthIntegration = has(/^src\/services\/(?:garmin|apple-health|wearable|readiness|body-battery)|^src\/api\/routes\/(?:wearable|health-data|garmin-auth)|^__tests__\/(?:services\/garmin-|services\/apple-health-|services\/integration-health-|api\/wearable-|api\/health-data-|api\/garmin-auth-|portal\/integration-health-)/);
  flags.rateLimit = has(/^src\/(?:api\/middleware\/rate-limit|services\/rate-limiter|api\/middleware\/auth-rate-limit)|^__tests__\/api\/rate-limiter/);
  flags.audit = has(/^src\/(?:services\/audit-trail|api\/routes\/audit-trail|portal\/admin-audit|portal\/admin-data-routes)|^__tests__\/(?:services\/audit-trail|api\/authenticated-support-routes-scope|portal\/portal-admin-audit|portal\/portal-admin-data-routes|portal\/portal-admin-data-isolation)/);
  flags.deployConfig ||= has(/(^|\/)ecosystem(?:\.staging)?\.config\.js$|^src\/config\.ts$|^scripts\/(?:install-ollama|staging-smoke-ollama)\.sh$|^__tests__\/config|^__tests__\/scripts\/(?:release-runtime-safeguards|exact-promotion-operational-safety)/);
  flags.eventBackbone = has(/^src\/services\/(?:event-outbox|background-job-queue|product-decision-log|app-summary-read-models|delta-sync|resource-budgets|event-backbone-worker)|^src\/api\/routes\/(?:summaries|sync)|^migrations\/[0-9]+_event_backbone|^__tests__\/(?:services\/event-backbone|api\/event-backbone)/);
  if (has(/^src\/services\/chat\/|^src\/services\/chat-reasoning|^src\/api\/routes\/chat-message-routes|^__tests__\/services\/chat-reasoning|^__tests__\/api\/chat-routes/)) {
    flags.chatReasoning = true;
    flags.secretary = true;
  }
  flags.chatCoreV2 = has(/^src\/services\/chat-core-v2\/|^__tests__\/services\/chat-core-v2-/);

  for (const file of files) {
    if (/\.swift$/.test(file)) flags.iosSrc = true;
    if (/UITests|UITest\.swift/.test(file)) {
      flags.iosUi = true;
      flags.iosTest = true;
    } else if (/Tests|Test\.swift/.test(file)) {
      flags.iosTest = true;
    }
    if (/Core\/AuthManager\.swift|Core\/KeychainHelper\.swift|Views\/Auth\/|Auth.*Tests\.swift|Keychain.*Tests\.swift|GoogleAuthCallbackResolverTests\.swift/.test(file)) flags.iosAuth = true;
    if (/MainTabView\.swift|RootView\.swift|AppState\.swift|Navigation|ViewModel\.swift|DashboardViewModel\.swift|TrainingViewModel\.swift|ChatViewModel\.swift|TasksViewModel\.swift|NavigationPerformance|Responsiveness|HomeWeekNavigationPerformanceUITests\.swift|AppWideResponsivenessUITests\.swift/.test(file)) flags.iosNavigation = true;
    if (/Service\.swift|Repository\.swift|DTO|Contract|Decoder|Response.*\.swift|ContractDecoderResilienceTests\.swift|HomeViewStateContractDecodingTests\.swift|TrainingHomeViewStateContractDecodingTests\.swift|ContentHomeContractDecodingTests\.swift|PlanGenerateResponse.*Tests\.swift/.test(file)) flags.iosDto = true;
    if (/Notification|DecisionCenter|InboxView\.swift|DeepLinkRouter\.swift/.test(file)) iosNotification = true;
  }
  if (flags.iosAuth) flags.authOrTenant = true;
  if (flags.iosNavigation || flags.iosDto || iosNotification) flags.iosSrc = true;

  flags.irreversibleMigration = flags.migration
    && (irreversiblePolicyChanged
      || isIrreversibleMigration(files, root, fileExists, readText, irreversiblePolicyPath));
  try {
    const triggers = fullSuiteTriggers ?? loadFullSuiteTriggers(root, policyPath);
    const matchers = triggers.map(globToRegExp);
    flags.fullSuiteTrigger = flags.testTopologyChange
      || files.some((file) => BOOTSTRAP_FULL_SUITE_PATHS.has(file)
        || matchers.some((matcher) => matcher.test(file)));
  } catch {
    flags.fullSuiteTrigger = true;
  }

  const tiers = ['T0'];
  const cannotSkip = [];
  const addGate = (condition, gate) => {
    if (!cannotSkipGateNameSet.has(gate)) {
      throw new Error(`Cannot-skip gate is not registered: ${gate}`);
    }
    if (condition) cannotSkip.push(gate);
  };
  addGate(flags.authOrTenant, 'tenant-auth-security');
  addGate(flags.memoryOrRetrieval, 'memory-retrieval-isolation');
  addGate(flags.prompt, 'prompt-injection-defense');
  addGate(flags.calendar, 'calendar-agenda-lifecycle');
  addGate(flags.providerRouting, 'provider-routing-fallback');
  addGate(flags.migration, 'migration-rollback-review');
  addGate(flags.irreversibleMigration, 'irreversible-migration-manual-approval');
  addGate(sciencePolicyJson, 'science-policy-version-check');
  addGate(flags.releaseOperator, 'exact-release-promotion-rehearsal');
  addGate(flags.hook, 'hook-validation-on-feature-branch');
  addGate(flags.ciWorkflow, 'ci-workflow-validation-on-PR');
  addGate(flags.testConfig, 'test-config-mock-completeness-audit');
  addGate(flags.fullSuiteTrigger, 'test-infrastructure-full-suite');
  addGate(!impactResolved, 'unresolved-change-impact-full-verification');
  addGate(flags.attachment, 'attachment-tenant-isolation');
  addGate(flags.modelRouting, 'model-routing-cost-attribution');
  addGate(flags.personalizationScope, 'personalization-scope-isolation');
  addGate(flags.contentAgent, 'content-agent-neutrality');
  addGate(flags.logger, 'logger-redaction-pii-scan');
  addGate(flags.scheduler, 'scheduler-tenant-scope-and-failure');
  addGate(flags.notification, 'notification-apns-delivery-and-tenant');
  addGate(flags.healthIntegration, 'health-integration-tenant-isolation');
  addGate(flags.rateLimit, 'auth-rate-limit-and-lockout');
  addGate(flags.audit, 'audit-trail-emission-and-scope');
  addGate(flags.deployConfig, 'deploy-config-health-rehearsal');
  addGate(flags.eventBackbone, 'event-backbone-jobs-sync-tenant-isolation');
  addGate(flags.iosNavigation, 'ios-navigation-responsiveness');
  addGate(flags.iosDto, 'ios-contract-decoder-resilience');
  addGate(iosNotification, 'ios-notification-decision-center');
  addGate(flags.appleNotificationWebhook, 'apple-notifications-jws-verify');
  addGate(flags.trainingEntitlement, 'training-routes-entitlement');
  addGate(flags.training, 'training-plan-create-e2e');
  addGate(flags.contentPromptCleanliness, 'content-engine-prompt-cleanliness');
  addGate(voiceEvolutionMultiTenant, 'voice-evolution-multi-tenant');
  addGate(videoStudyPromptCleanliness, 'video-study-prompt-cleanliness');
  addGate(channelLearnerPromptCleanliness, 'channel-learner-prompt-cleanliness');
  addGate(globalCostGuardrailRest, 'cost-guardrail-global-rest');
  addGate(cacheCoherenceRegistry, 'cache-coherence-registry');
  addGate(cachedRouteHandler, 'cached-route-handler');
  addGate(garminAppleHealthCascade, 'garmin-tenant-leak-and-apple-health-cascade');
  addGate(googleDriveTenantLeak, 'google-drive-tenant-leak');
  addGate(registryRealEval, 'registry-real-eval-quality-gates');

  if (nonDoc) tiers.push('T1');
  if (flags.apiRoute || flags.portal || flags.pythonEngine || flags.iosUi || flags.training
    || flags.cooking || flags.content || flags.secretary || flags.eventBackbone) tiers.push('T2');
  if (flags.testConfig) tiers.push('T3-recommended');
  if (flags.packageJson) tiers.push('T3-recommended');
  if (flags.fullSuiteTrigger) tiers.push('T3-required');
  if (flags.backendSrc || flags.migration || flags.pythonEngine || flags.deployConfig
    || flags.releaseOperator) tiers.push('T4');
  tiers.push('T5-on-promote', 'T6-postdeploy');

  let vitestMode = 'skip';
  let vitestGlobs = [];
  const pytestGlobs = [];
  const addVitest = (condition, ...globs) => { if (condition) vitestGlobs.push(...globs); };
  if (nonDoc) {
    if (flags.testConfig || flags.packageJson || flags.highFanIn) {
      vitestMode = 'full';
    } else if (flags.backendSrc || flags.backendTest || flags.deployConfig || flags.releaseOperator || flags.operationsTooling) {
      vitestMode = 'focused';
      addVitest(flags.training, '__tests__/services/training-*.test.ts', '__tests__/services/coach-kernel-*.test.ts', '__tests__/api/training-*.test.ts', '__tests__/integration/training-plan-create-cycle.test.ts');
      addVitest(flags.trainingEntitlement, '__tests__/security/training-routes-entitlement.test.ts');
      addVitest(flags.calendar, '__tests__/services/calendar*.test.ts', '__tests__/api/training-calendar-*.test.ts', '__tests__/api/training-plan-calendar-*.test.ts');
      addVitest(flags.providerRouting, '__tests__/services/provider-*.test.ts', '__tests__/services/ai-provider*.test.ts');
      addVitest(flags.authOrTenant, '__tests__/security/**/*.test.ts', '__tests__/scope/**/*.test.ts', '__tests__/api/auth-*.test.ts', '__tests__/api/connections-tenant-*.test.ts', '__tests__/services/google-sign-in.test.ts', '__tests__/services/apple-sign-in-nonce.test.ts', '__tests__/services/oauth*.test.ts', '__tests__/portal/portal-oauth-routes.test.ts');
      addVitest(flags.memoryOrRetrieval, '__tests__/services/*context*.test.ts', '__tests__/services/*memory*.test.ts');
      addVitest(flags.prompt, '__tests__/security/**/*.test.ts');
      addVitest(flags.cooking, '__tests__/services/*cooking*.test.ts', '__tests__/api/cooking-*.test.ts');
      addVitest(flags.content, '__tests__/services/content-*.test.ts', '__tests__/api/content-*.test.ts');
      addVitest(flags.finance, '__tests__/services/finance-*.test.ts', '__tests__/services/invoice-*.test.ts', '__tests__/security/finance-*.test.ts');
      addVitest(flags.secretary, '__tests__/services/secretary-*.test.ts');
      addVitest(flags.portal, '__tests__/portal/*.test.ts');
      addVitest(flags.attachment, '__tests__/api/chat-attachments*.test.ts', '__tests__/api/chat-message-attachments*.test.ts', '__tests__/services/fiscal-bundle-attachments*.test.ts', '__tests__/security/**/*.test.ts');
      addVitest(flags.modelRouting, '__tests__/services/domain-provider-router*.test.ts', '__tests__/services/model-routing-*.test.ts', '__tests__/services/ollama-small-only-policy.test.ts', '__tests__/services/ollama-provider.test.ts', '__tests__/services/model-config.test.ts');
      addVitest(flags.personalizationScope, '__tests__/services/cooking-preferences*.test.ts', '__tests__/services/finance-preferences*.test.ts', '__tests__/services/skill-memory*.test.ts', '__tests__/services/content-references*.test.ts', '__tests__/security/**/*.test.ts');
      addVitest(
        flags.contentAgent,
        '__tests__/security/content-agent-neutrality.test.ts',
        '__tests__/services/cross-agent-learning*.test.ts',
        '__tests__/services/*mesh-context.test.ts',
        '__tests__/services/mesh-context-scope.test.ts',
        '__tests__/portal/domain-status.test.ts',
      );
      addVitest(flags.logger, '__tests__/utils/logger-*.test.ts', '__tests__/api/secret-guards.test.ts');
      addVitest(
        flags.scheduler,
        '__tests__/services/scheduler-*.test.ts',
        '__tests__/services/agent-job-runner.test.ts',
        '__tests__/services/scheduled-agent-job-governance.test.ts',
        '__tests__/services/chat-action-fixer-worker.test.ts',
        '__tests__/services/channel-learner-relearn-gate.test.ts',
        '__tests__/services/garmin-coach-user-scope.test.ts',
        '__tests__/agents/voice-evolution-multi-tenant.test.ts',
        '__tests__/scripts/runtime-manifests.test.ts',
      );
      addVitest(flags.notification, '__tests__/services/apns-*.test.ts', '__tests__/services/notification-*.test.ts', '__tests__/services/decision-center.test.ts', '__tests__/services/decision-center-logic-v2.test.ts', '__tests__/services/content-notifications*.test.ts', '__tests__/api/notifications-*.test.ts', '__tests__/api/decisions-routes.test.ts', '__tests__/api/content-notification-*.test.ts', '__tests__/security/notification-*.test.ts', '__tests__/security/p0-chat-identity-isolation.test.ts');
      addVitest(flags.healthIntegration, '__tests__/services/garmin-*.test.ts', '__tests__/services/apple-health-*.test.ts', '__tests__/services/integration-health-*.test.ts', '__tests__/api/wearable-*.test.ts', '__tests__/api/health-data-*.test.ts', '__tests__/api/garmin-auth-*.test.ts', '__tests__/portal/integration-health-*.test.ts');
      addVitest(flags.rateLimit, '__tests__/api/rate-limiter.test.ts', '__tests__/security/**/*.test.ts');
      addVitest(flags.audit, '__tests__/services/audit-trail.test.ts', '__tests__/api/authenticated-support-routes-scope.test.ts', '__tests__/portal/portal-admin-audit.test.ts', '__tests__/portal/portal-admin-data-routes.test.ts', '__tests__/portal/portal-admin-data-isolation.integration.test.ts');
      addVitest(flags.deployConfig, '__tests__/services/config-*.test.ts', '__tests__/portal/health-endpoint*.test.ts', '__tests__/portal/health-endpoints.test.ts', '__tests__/scripts/*.test.ts', '__tests__/security/**/*.test.ts');
      addVitest(flags.runtimeInfra, '__tests__/scripts/*.test.ts', '__tests__/security/github-workflow-pinning.test.ts');
      addVitest(flags.eventBackbone, '__tests__/services/event-backbone.test.ts', '__tests__/api/event-backbone-routes.test.ts', '__tests__/security/**/*.test.ts');
      addVitest(flags.chatReasoning, '__tests__/services/chat-action-planner.test.ts', '__tests__/services/chat-action-production-safety.test.ts', '__tests__/api/chat-routes.test.ts', '__tests__/security/p0-chat-identity-isolation.test.ts');
      addVitest(flags.chatCoreV2, '__tests__/services/chat-core-v2-*.test.ts');
      addVitest(flags.appleNotificationWebhook, '__tests__/security/billing-apple-notifications-jws-verify.test.ts');
      addVitest(flags.trainingEntitlement, '__tests__/security/training-routes-entitlement.test.ts');
      addVitest(voiceEvolutionMultiTenant, '__tests__/agents/voice-evolution-multi-tenant.test.ts');
      addVitest(videoStudyPromptCleanliness, '__tests__/services/video-study-prompt-cleanliness.test.ts');
      addVitest(channelLearnerPromptCleanliness, '__tests__/services/channel-learner-prompt-cleanliness.test.ts');
      addVitest(globalCostGuardrailRest, '__tests__/security/cost-guardrail-global-rest.test.ts');
      addVitest(cacheCoherenceRegistry, '__tests__/services/cache-coherence-registry.test.ts');
      addVitest(cachedRouteHandler, '__tests__/api/cached-route-handler.test.ts');
      addVitest(garminAppleHealthCascade, '__tests__/security/garmin-tenant-leak-and-apple-health-cascade.test.ts');
      addVitest(googleDriveTenantLeak, '__tests__/security/google-drive-tenant-leak.test.ts');
      addVitest(registryRealEval, '__tests__/services/registry-real-eval-gates.test.ts', '__tests__/services/chat-action-registry-shadow-parity.test.ts', '__tests__/services/chat-action-registry-completeness.test.ts', '__tests__/services/registry-driven-eval-scenarios.test.ts', '__tests__/services/registry-real-eval-scoring.test.ts');
      addVitest(
        flags.releaseOperator,
        '__tests__/scripts/release-artifact-manifest.test.ts',
        '__tests__/scripts/release-manifest-v2.test.ts',
        '__tests__/scripts/trusted-release-signing.test.ts',
        '__tests__/scripts/release-runtime-safeguards.test.ts',
        '__tests__/scripts/exact-promotion-operational-safety.test.ts',
        '__tests__/scripts/release-exact-attestations.test.ts',
        '__tests__/scripts/release-backup-runtime-artifact.test.ts',
        '__tests__/scripts/production-shape-migration-rehearsal.test.ts',
        '__tests__/scripts/rollback-versioned-runtime.test.ts',
        '__tests__/scripts/pm2-sanitized-start.test.ts',
        '__tests__/scripts/release-evidence-container.test.ts',
        '__tests__/scripts/release-sequence.test.ts',
        '__tests__/scripts/persistent-promotion-transaction.test.ts',
        '__tests__/scripts/remote-release-capacity.test.ts',
        '__tests__/scripts/release-runtime-dependencies.test.ts',
        '__tests__/scripts/release-plan-evaluator.test.ts',
        '__tests__/scripts/rollback-drill-check.test.ts',
        '__tests__/scripts/protected-main-ci-evidence.test.ts',
      );
      addVitest(
        flags.operationsTooling,
        '__tests__/scripts/quality-sonar-operations.test.ts',
        '__tests__/scripts/application-disaster-recovery.test.ts',
        '__tests__/scripts/ollama-observation-collector.test.ts',
        '__tests__/scripts/ollama-large-model-cleanup.test.ts',
        '__tests__/scripts/ollama-systemd-envelope.test.ts',
      );
      if (flags.contentPromptCleanliness) pytestGlobs.push('content-engine/tests/test_prompt_cleanliness.py');
      if (vitestGlobs.length === 0) vitestMode = 'changed-only';
    }
  }
  if (flags.runtimeInfra || flags.fullSuiteTrigger || !impactResolved) {
    vitestMode = 'full';
    vitestGlobs = [];
  }
  if (flags.migration && vitestMode === 'skip') vitestMode = 'changed-only';
  if (flags.prompt && vitestMode === 'skip') {
    vitestMode = 'focused';
    vitestGlobs.push('__tests__/security/**/*.test.ts', '__tests__/services/prompt-cleanliness.test.ts');
  }
  if (flags.contentPromptCleanliness) pytestGlobs.push('content-engine/tests/test_prompt_cleanliness.py');
  if (flags.pythonEngine) pytestGlobs.push('content-engine/tests');

  const xctestClasses = [];
  let xctestMode = 'skip';
  if (flags.iosSrc) {
    xctestMode = 'focused';
    if (flags.iosUi) xctestClasses.push('Nexus HubUITests/*');
    if (flags.iosAuth) xctestClasses.push('Nexus HubTests/AppleSignInNonceTests', 'Nexus HubTests/KeychainHelperTests', 'Nexus HubTests/AuthManagerFixtureLeakTests', 'Nexus HubTests/AuthManagerPersistenceTests', 'Nexus HubTests/AuthUserPresentationTests', 'Nexus HubTests/GoogleAuthCallbackResolverTests');
    if (flags.iosNavigation) xctestClasses.push('Nexus HubTests/NavigationPerformanceSourcePinsTests', 'Nexus HubTests/MainTabViewBadgeMemoizationTests', 'Nexus HubUITests/AppWideResponsivenessUITests', 'Nexus HubUITests/HomeWeekNavigationPerformanceUITests');
    if (flags.iosDto) xctestClasses.push('Nexus HubTests/ContractDecoderResilienceTests', 'Nexus HubTests/HomeViewStateContractDecodingTests', 'Nexus HubTests/TrainingHomeViewStateContractDecodingTests', 'Nexus HubTests/ContentHomeContractDecodingTests');
    if (iosNotification) xctestClasses.push('Nexus HubTests/NotificationManagerTests', 'Nexus HubTests/DeepLinkRouterTests', 'Nexus HubTests/NotificationDecisionCenterTests', 'Nexus HubUITests/NotificationDecisionCenterUITests');
    xctestClasses.push('Nexus HubTests/ContractDecoderResilienceTests', 'Nexus HubTests/AuthManagerPersistenceTests');
  }

  const smokeDomains = [];
  const stagingGeneric = flags.backendSrc || flags.migration || flags.pythonEngine || flags.deployConfig
    || flags.runtimeInfra || flags.releaseOperator;
  if (flags.training) smokeDomains.push('smoke:training-cross-skill:staging');
  if (flags.calendar) smokeDomains.push('smoke:training-calendar:staging');
  if (flags.cooking) smokeDomains.push('smoke:cooking:portal');
  if (flags.content) smokeDomains.push('smoke:content:local');

  flags.docsOnly = docsOnly;
  const skipReason = vitestMode === 'skip'
    ? (docsOnly
      ? 'docs-only diff; no source/test/config/hook/migration/release-operator file in scope'
      : 'no Vitest-relevant files in scope')
    : null;

  return {
    version: '1',
    generatedAt,
    baseRef,
    head,
    changedFileCount: files.length,
    changedFiles: files,
    tiers: dedupe(tiers),
    vitest: { mode: vitestMode, globs: dedupe(vitestGlobs), skipReason },
    pytest: { globs: dedupe(pytestGlobs) },
    xctest: { mode: xctestMode, classes: dedupe(xctestClasses) },
    stagingSmoke: { generic: stagingGeneric, domains: dedupe(smokeDomains) },
    cannotSkip: dedupe(cannotSkip),
    flags,
  };
}

export function formatClassifierMarkdown(result) {
  const lines = [
    '# Changed-area classifier',
    '',
    `- Base: \`${result.baseRef}\``,
    `- Head: \`${result.head}\``,
    `- Changed files: ${result.changedFileCount}`,
    `- Generated at: ${result.generatedAt}`,
    '',
    '## Recommended tiers',
    ...result.tiers.map((tier) => `- ${tier}`),
    '',
    '## Vitest',
    `- mode: \`${result.vitest.mode}\``,
  ];
  if (result.vitest.mode === 'skip') lines.push(`- reason: ${result.vitest.skipReason}`);
  else if (result.vitest.mode === 'changed-only') lines.push(`- recommendation: \`npx vitest run --changed ${result.baseRef}\``);
  else if (result.vitest.mode === 'focused') {
    lines.push('- focused globs:', ...result.vitest.globs.map((glob) => `  - \`${glob}\``));
  } else lines.push('- run: `npx vitest run` (full)');
  lines.push('', '## Pytest');
  lines.push(...(result.pytest.globs.length > 0 ? result.pytest.globs.map((glob) => `- \`${glob}\``) : ['- (none)']));
  lines.push('', '## XCTest', `- mode: \`${result.xctest.mode}\``);
  if (result.xctest.mode === 'focused') lines.push(...result.xctest.classes.map((name) => `- \`${name}\``));
  lines.push('', '## Staging smoke', `- generic 17-check: \`${result.stagingSmoke.generic}\``);
  if (result.stagingSmoke.domains.length > 0) {
    lines.push('- domain smokes:', ...result.stagingSmoke.domains.map((domain) => `  - \`npm run ${domain}\``));
  } else lines.push('- domain smokes: none required');
  lines.push('', '## Cannot-skip safety gates');
  lines.push(...(result.cannotSkip.length > 0 ? result.cannotSkip.map((gate) => `- ${gate}`) : ['- (none triggered by this diff)']));
  lines.push('', '## Changed files');
  lines.push(...(result.changedFiles.length > 0 ? result.changedFiles.map((file) => `- \`${file}\``) : ['(none — clean tree)']));
  return `${lines.join('\n')}\n`;
}
