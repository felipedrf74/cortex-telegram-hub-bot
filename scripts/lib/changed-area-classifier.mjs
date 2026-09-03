// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import fs from 'node:fs';
import path from 'node:path';
import {
  irreversibleMigrationReason,
  loadIrreversibleMigrationPolicy,
} from './irreversible-migration-policy.mjs';
import {
  isProductionMigrationArchivePath,
  migrationSafetyGovernanceReason,
} from './migration-safety-policy-classifier.mjs';
import { isDocsOnly } from './test-groups.mjs';

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

export function assertResolvedChangeImpact(impactResolved, baseRef) {
  if (!impactResolved) {
    throw new Error(
      `Changed-file impact is unresolved because base '${baseRef}' is not an ancestor of HEAD. `
      + 'Use an exact ancestor SHA; automatic full-suite fallback is intentionally disabled.',
    );
  }
}

function matches(files, pattern) {
  const regex = pattern instanceof RegExp ? pattern : new RegExp(pattern);
  return files.some((file) => regex.test(file));
}

function dedupe(values) {
  return [...new Set(values.filter(Boolean))];
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
  let docsOnly = impactResolved && isDocsOnly(files);
  let nonDoc = !docsOnly;
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
  let localPrimaryInference = false;

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
  const irreversiblePolicyChanged = files.some((file) => (
    migrationSafetyGovernanceReason(file) !== null
  ));
  flags.migration ||= has(/^migrations\//) || irreversiblePolicyChanged;
  flags.pythonEngine ||= has(/^content-engine\//);
  flags.appleNotificationWebhook = has(/^src\/api\/router\.ts$|^src\/api\/routes\/billing\.ts$|^src\/services\/apple-jws-verifier\.ts$|^__tests__\/security\/billing-apple-notifications-jws-verify\.test\.ts$/);
  globalCostGuardrailRest = has(/^src\/services\/cost-guardrail\.ts$|^src\/api\/routes\/(?:chat-message-request|training-plan-routes|training|content-script-routes|finance)\.ts$|^__tests__\/security\/cost-guardrail-global-rest\.test\.ts$/);
  cacheCoherenceRegistry = has(/^src\/services\/cache-coherence-registry\.ts$|^__tests__\/services\/cache-coherence-registry\.test\.ts$/);
  cachedRouteHandler = has(/^src\/api\/route-helpers\/(?:cached-route-handler|provider-error-classifier)\.ts$|^src\/api\/routes\/(?:calendar|content|dashboard|notifications|plan|tasks)\.ts$|^__tests__\/api\/cached-route-handler\.test\.ts$/);
  garminAppleHealthCascade = has(/^src\/services\/(?:garmin|garmin-session-store|readiness-scorer)\.ts$|^src\/services\/wearable\/(?:wearable-service|apple-health-adapter|types)\.ts$|^src\/api\/routes\/(?:dashboard-data-fetchers|health-data)\.ts$|^__tests__\/security\/garmin-tenant-leak-and-apple-health-cascade\.test\.ts$/);
  googleDriveTenantLeak = has(/^src\/services\/(?:google-drive|google-auth)\.ts$|^__tests__\/security\/google-drive-tenant-leak\.test\.ts$|^scripts\/cleanup-tainted-google-drive-sessions\.mjs$/);
  registryRealEval = has(/^src\/services\/chat\/registry\/|^src\/services\/registry-(?:driven-eval-scenarios|real-eval-scoring|telemetry-report|adversarial-discovery|adversarial-example-proposer|readable-intents-proposer|cross-tenant-alert-hook)\.ts$|^src\/services\/build-llm-safe-prompt-slice\.ts$|^src\/services\/skills\/|^__tests__\/services\/(?:chat-action-registry-|registry-(?:driven-eval|real-eval|telemetry-report|adversarial|readable-intents|cross-tenant))|^__tests__\/scripts\/registry-feedback-report\.test\.ts$|^scripts\/registry-feedback-report\.ts$/);

  // Keep CI evidence selection aligned with the signed controller fingerprint.
  // A controller module or trust/config input can change release authority even
  // when no application source or ops README changes in the same commit.
  const releaseControlPlane = has(/^(?:package\.json|package-lock\.json)$/)
    || has(/^ops\/nexus-release(?:\/|$)/)
    || has(/^config\/continuous-deployment\.json$/)
    || has(/^docs\/release\/evidence\/release-manifest-public-key\.pem$/)
    || has(/^scripts\/release-.*\.(?:mjs|py|sh)$/)
    || has(/^scripts\/remote-(?:pm2-root-install|start-sanitized-pm2|user-release-transaction)\.sh$/)
    || has(/^scripts\/(?:recover-pm2-root-attestation|retire-pm2-fallback)\.mjs$/)
    || has(/^scripts\/lib\/release-.*\.mjs$/)
    || has(/^scripts\/lib\/(?:git-(?:changed-paths|ref)|migration-(?:cd-eligibility|safety-policy-classifier)|pm2-(?:fallback-retirement|root-attestation-recovery)|production-migration-lineage)\.mjs$/);
  const localBackupRuntime = has(/^ops\/local-backup(?:\/|$)/)
    || has(/^scripts\/local-backup(?:\.py|-(?:retry-launcher|systemd-install)\.sh)$/);
  if (releaseControlPlane) {
    nonDoc = true;
    docsOnly = false;
  }

  flags.releaseOperator = releaseControlPlane
    || has(/^config\/production-migration-lineages\.json$/)
    || files.some(isProductionMigrationArchivePath)
    || has(/^scripts\/(?:release-operator|promote-exact-release|build-release-runtime-dependencies|chat-capability-flag-operator|remote-chat-capability-flag-transaction|remote-user-release-transaction)\.sh$/)
    || has(/^scripts\/(?:release-artifact-manifest|release-bundle|release-checksum-manifest|release-runtime-dependencies|routing-divergence-report)\.mjs$/)
    || has(/^scripts\/generate-python-release-lock\.mjs$/)
    || has(/^scripts\/run-routing-action-skill-accuracy\.ts$/)
    || has(/^scripts\/lib\/(?:chat-capability-flag-transaction|release-artifact-manifest|release-bootstrap|production-migration-lineage)\.mjs$/)
    || has(/^src\/services\/chat-capability-runtime-guard\.ts$/)
    || has(/^src\/tools\/(?:chat-capability-cross-skill-preflight|routing-action-skill-accuracy|training-cross-skill-staging-smoke)\.ts$/)
    || has(/^Dockerfile\.release\.python$/)
    || has(/^content-engine\/(?:requirements\.txt|requirements-release\.txt|requirements-lock-tool\.txt|requirements-audit-tool\.(?:in|txt))$/);
  flags.operationsTooling = has(/^ops\/(?:sonarqube|ollama|cloudflared)\//)
    || has(/^scripts\/(?:quality-sonar-|cloudflared-systemd-migrate|local-inference-socket-transaction|local-model-benchmark-envelope-transaction|ollama-(?:lean-finalize|service-envelope-check|systemd-dropin-transaction|install-state-check))/)
    || has(/^scripts\/systemd\/nexus-local-inference-sockets\.conf$/)
    || has(/^scripts\/lib\/ollama-service-envelope\.mjs$/)
    || has(/^__tests__\/scripts\/(?:quality-sonar|cloudflared-systemd-migration|ollama-lean-finalize)\.test\.ts$/);
  if (has(/^scripts\/lib\/release-gates\.sh$/)) {
    flags.runtimeInfra = true;
    flags.deployConfig = true;
  }
  if (releaseControlPlane || localBackupRuntime) {
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
  flags.modelRouting = has(/^config\/local-model-manifest\.json$|^scripts\/validate-local-model-manifest\.mjs$|^src\/services\/(?:domain-provider-router|local-model-|ollama-model-policy|ollama-provider|model-config)|^src\/tools\/local-model-bakeoff\.ts$|^src\/portal\/provider-routes|^__tests__\/services\/(?:domain-provider-router|local-model-|model-routing-|ollama-small-only-policy|ollama-provider|model-config)/);
  localPrimaryInference = has(
    /^config\/local-model-manifest\.json$|^migrations\/(?:down\/)?284_|^src\/(?:api\/(?:request-timer|routes\/(?:content|content-script-job-routes|content-script-routes|internal|local-inference-admin))|portal\/plan-routes|services\/(?:api-usage-attribution|chat-core-v2\/(?:local-chat-orchestrator|local-inference-concurrency-gate|model-residency-policy)|classify-shadow|content-agent-jobs|content-engine(?:-script-attribution|-script-runtime)?|content-script-job|cost-guardrail|internal-inference-attribution|local-inference-|local-llm-(?:error|rate-limiter)|local-model-|local-primary-|ollama-(?:model-policy|provider|transport)|provider-fallback|skill-inference-|user-data-export)|tools\/(?:local-model-bakeoff|ollama-unix-gateway))|^content-engine\/(?:models\/requests|routers\/research|services\/(?:claude_client|inference_vocabulary|creative\/script_writer)|tests\/)|^scripts\/(?:local-inference-|local-model-|validate-local-model-manifest)|^__tests__\/(?:api\/(?:content-script-job-routes|content-script-quota|internal-routes-runtime|local-inference-admin-routes|request-timer-local-inference)|migrations\/local-primary-inference-foundation|portal\/portal-plan-routes|scripts\/(?:local-inference-|local-model-)|services\/(?:api-usage-attribution|chat-core-v2-local-|content-agent-jobs|content-script-job|cost-guardrail|internal-inference-attribution|local-inference-|local-llm-rate-limiter|local-model-|local-primary-|ollama-(?:transport|unix-gateway)|option-3-classifier|paid-ai-budget|provider-fallback|skill-inference-))/,
  );
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

  const tiers = ['T0'];

  if (nonDoc) tiers.push('T1');
  if (flags.apiRoute || flags.portal || flags.pythonEngine || flags.iosUi || flags.training
    || flags.cooking || flags.content || flags.secretary || flags.eventBackbone) tiers.push('T2');
  if (flags.testConfig) tiers.push('T3-recommended');
  if (flags.packageJson) tiers.push('T3-recommended');
  if (flags.backendSrc || flags.migration || flags.pythonEngine || flags.deployConfig
    || flags.releaseOperator) tiers.push('T4');
  tiers.push('T5-on-promote', 'T6-postdeploy');

  let vitestMode = 'skip';
  let vitestGlobs = [];
  const pytestGlobs = [];
  const addVitest = (condition, ...globs) => { if (condition) vitestGlobs.push(...globs); };
  if (nonDoc) {
    vitestMode = 'focused';
    if (flags.backendSrc || flags.backendTest || flags.deployConfig || flags.releaseOperator
      || flags.operationsTooling || flags.runtimeInfra || flags.testConfig || flags.packageJson
      || flags.highFanIn) {
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
      addVitest(
        localPrimaryInference,
        '__tests__/api/content-script-job-routes.test.ts',
        '__tests__/api/content-script-quota.test.ts',
        '__tests__/api/internal-routes-runtime.test.ts',
        '__tests__/api/local-inference-admin-routes.test.ts',
        '__tests__/api/request-timer-local-inference.test.ts',
        '__tests__/migrations/local-primary-inference-foundation.test.ts',
        '__tests__/portal/portal-plan-routes.test.ts',
        '__tests__/scripts/local-inference-*.test.ts',
        '__tests__/scripts/local-model-*.test.ts',
        '__tests__/services/content-script-job*.test.ts',
        '__tests__/services/content-agent-jobs.test.ts',
        '__tests__/services/cost-guardrail.test.ts',
        '__tests__/services/internal-inference-attribution.test.ts',
        '__tests__/services/chat-core-v2-local-*.test.ts',
        '__tests__/services/local-inference-*.test.ts',
        '__tests__/services/local-llm-rate-limiter.test.ts',
        '__tests__/services/local-model-*.test.ts',
        '__tests__/services/local-primary-*.test.ts',
        '__tests__/services/ollama-transport.test.ts',
        '__tests__/services/ollama-unix-gateway.test.ts',
        '__tests__/services/option-3-classifier.test.ts',
        '__tests__/services/paid-ai-budget.test.ts',
        '__tests__/services/provider-fallback.test.ts',
        '__tests__/services/skill-inference-*.test.ts',
      );
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
        '__tests__/scripts/release-runtime-dependencies.test.ts',
        '__tests__/scripts/lean-release-path.test.ts',
      );
      addVitest(
        flags.operationsTooling,
        '__tests__/scripts/cloudflared-systemd-migration.test.ts',
        '__tests__/scripts/local-inference-socket-transaction.test.ts',
        '__tests__/scripts/local-model-benchmark-envelope-transaction.test.ts',
        '__tests__/scripts/ollama-lean-finalize.test.ts',
      );
      if (flags.contentPromptCleanliness) pytestGlobs.push('content-engine/tests/test_prompt_cleanliness.py');
    }
  }
  if (flags.contentPromptCleanliness) pytestGlobs.push('content-engine/tests/test_prompt_cleanliness.py');
  if (flags.pythonEngine) pytestGlobs.push('content-engine/tests');

  const xctestClasses = [];
  let xctestMode = 'skip';
  if (flags.iosSrc) {
    xctestMode = 'focused';
    for (const file of files) {
      const changedTest = /^(Nexus Hub(?:UI)?Tests)\/(?:.*\/)?([^/]+Tests)\.swift$/.exec(file);
      if (changedTest) xctestClasses.push(`${changedTest[1]}/${changedTest[2]}`);
    }
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
    cannotSkip: [],
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
  else lines.push('- focused groups select core contracts, static dependents, and owner tests');
  lines.push('', '## Pytest');
  lines.push(...(result.pytest.globs.length > 0 ? result.pytest.globs.map((glob) => `- \`${glob}\``) : ['- (none)']));
  lines.push('', '## XCTest', `- mode: \`${result.xctest.mode}\``);
  if (result.xctest.mode === 'focused') lines.push(...result.xctest.classes.map((name) => `- \`${name}\``));
  lines.push('', '## Staging smoke', `- generic 17-check: \`${result.stagingSmoke.generic}\``);
  if (result.stagingSmoke.domains.length > 0) {
    lines.push('- domain smokes:', ...result.stagingSmoke.domains.map((domain) => `  - \`npm run ${domain}\``));
  } else lines.push('- domain smokes: none required');
  lines.push('', '## Changed files');
  lines.push(...(result.changedFiles.length > 0 ? result.changedFiles.map((file) => `- \`${file}\``) : ['(none — clean tree)']));
  return `${lines.join('\n')}\n`;
}
