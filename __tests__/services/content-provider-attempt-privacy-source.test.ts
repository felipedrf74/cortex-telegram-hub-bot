import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');
const read = (relativePath: string): string => readFileSync(path.join(root, relativePath), 'utf8');

describe('Content provider-attempt and privacy source contracts', () => {
  it('keeps provider dispatch single-attempt without post-failure provider switching', () => {
    const channelLearner = read('src/services/channel-learner.ts');
    const scriptJobs = read('src/services/content-script-jobs.ts');
    const workspaceRoutes = read('src/api/routes/content-workspace-routes.ts');
    const youtubeAnalytics = read('src/services/youtube-analytics.ts');
    const scheduler = read('src/services/scheduler.ts');
    const videoStudy = read('src/services/video-study.ts');
    const voiceEvolution = read('src/agents/voice-evolution-agent.ts');
    const contentChatShortcuts = read('src/api/routes/chat-message-shortcuts.ts');
    const internalRoutes = read('src/api/routes/internal.ts');
    const contentWorkflow = read('src/services/content-workflow.ts');
    const contentAgentJobs = read('src/services/content-agent-jobs.ts');

    for (const source of [
      channelLearner,
      videoStudy,
      voiceEvolution,
      contentChatShortcuts,
      internalRoutes,
      contentWorkflow,
      contentAgentJobs,
    ]) {
      expect(source).toContain('maxRetries: 0');
      expect(source).toContain('allowFallbackAfterProviderFailure: false');
    }
    expect(videoStudy).not.toContain('maxRetries: 3');
    expect(voiceEvolution).not.toContain('maxRetries: 2');
  });

  it('does not place raw provider or creator text in Content operational logs', () => {
    const videoStudy = read('src/services/video-study.ts');
    const contentWorkflow = read('src/services/content-workflow.ts');
    const scriptJobs = read('src/services/content-script-jobs.ts');
    const workspaceRoutes = read('src/api/routes/content-workspace-routes.ts');
    const youtubeAnalytics = read('src/services/youtube-analytics.ts');
    const scheduler = read('src/services/scheduler.ts');
    const agents = [
      read('src/agents/pipeline-agent.ts'),
      read('src/agents/seo-agent.ts'),
      read('src/agents/voice-evolution-agent.ts'),
    ].join('\n');
    const chatShortcuts = read('src/api/routes/chat-message-shortcuts.ts');
    const internalRoutes = read('src/api/routes/internal.ts');
    const scriptRoutes = read('src/api/routes/content-script-routes.ts');
    const discovery = read('src/services/content-discovery.ts');
    const engineHttp = read('src/services/content-engine-http.ts');
    const profilePayload = read('src/services/content-engine-profile-payload.ts');
    const engineErrorContract = read('src/services/content-engine-error-contract.ts');
    const youtubeTranscript = read('src/services/youtube-transcript.ts');
    const contentExecutor = read('src/services/skills/content/executor.ts');
    const creativeRoutes = read('src/api/routes/content-creative-routes.ts');
    const creatorProfileRoutes = read('src/api/routes/content-creator-profile-routes.ts');
    const channelLearner = read('src/services/channel-learner.ts');
    const pythonProxy = read('content-engine/services/claude_client.py');
    const planOrchestration = [
      read('src/services/daily-brief-orchestrator.ts'),
      read('src/services/weekly-plan-orchestrator.ts'),
      read('src/domains/secretary.ts'),
    ].join('\n');

    expect(videoStudy).not.toContain("logger.warn({ err");
    expect(videoStudy).not.toContain("logger.debug({ err");
    expect(videoStudy).not.toContain('{ channelName, topN');
    expect(videoStudy).not.toContain('logger.info({ videoId }');
    expect(videoStudy).not.toContain('title: transcript.title }, \'Transcript saved as DOCX\'');
    expect(contentWorkflow).not.toContain('logger.error({ err, format }');
    expect(contentWorkflow).not.toContain('logger.error({ err, responseChars: text.length }');
    expect(agents).not.toContain("Date.now() - start, err.message");
    expect(agents).not.toContain("logger.error({ err }");
    expect(chatShortcuts).not.toContain("\n          err,\n");
    expect(chatShortcuts).toContain('safeContentLogErrorFields(err)');
    expect(chatShortcuts).not.toContain('safeChatShortcutErrorFields');
    expect(internalRoutes).not.toContain("logger.error({ err }, 'Internal ai-complete failed')");
    expect(internalRoutes).toContain('return safeContentLogErrorFields(error).errorName');
    expect(internalRoutes).not.toContain('shadowError instanceof Error ? shadowError.name');
    expect(scriptRoutes).not.toContain("logger.error({ err");
    expect(scriptRoutes).not.toContain("logger.warn({ err");
    expect(scriptRoutes).not.toContain('{ releaseError, userId, tenantId }');
    expect(discovery).toContain('createLazyAnthropicClient({ maxRetries: 0 })');
    expect(engineHttp).not.toContain('error: lastError.message');
    expect(engineHttp).not.toContain('errorName: lastError.name');
    expect(engineHttp).toContain('safeContentLogErrorFields(lastError)');
    expect(profilePayload).not.toContain('logger.warn({ err');
    expect(engineErrorContract).not.toContain('? error.message');
    expect(youtubeTranscript).not.toContain('{ err, videoId }');
    expect(youtubeTranscript).not.toContain('{ input: videoIdOrUrl }');
    expect(youtubeTranscript).not.toContain('title: title.substring');
    expect(contentExecutor).not.toContain('err instanceof Error ? err.message : String(err)');
    expect(creativeRoutes).toContain('safeContentLogErrorFields(error)');
    expect(creativeRoutes).not.toContain('errorCode: candidate?.code');
    expect(creativeRoutes).not.toContain('errorName: candidate?.name');
    expect(creatorProfileRoutes).toContain('signalFingerprint: contentLogFingerprint(signalId)');
    expect(creatorProfileRoutes).not.toMatch(
      /logger\.(?:warn|error)\(\{[\s\S]{0,300}\n\s+signalId,\s*\n/,
    );
    expect(channelLearner).not.toContain('categories: synthesisInputs.map');
    expect(channelLearner).not.toContain('categories: directKnowledge.map');
    expect(channelLearner).not.toContain('channelId: channel.id, category');
    expect(scriptJobs).not.toContain('errorName: recoveryError instanceof Error');
    expect(scriptJobs).not.toContain('String((error as { code: string }).code)');
    expect(scriptJobs).toContain('contentScriptJobFailureCode(error, failureReason)');
    expect(workspaceRoutes).not.toContain('errorName: projectionError instanceof Error');
    expect(youtubeAnalytics).not.toContain('{ err, videoId }');
    expect(youtubeAnalytics).not.toContain('{ err, channelId }');
    expect(youtubeAnalytics).not.toContain('{ err, keyword }');
    expect(youtubeAnalytics).not.toContain('status: resp.status, videoId');
    expect(youtubeAnalytics).toContain('safeContentLogErrorFields(err)');
    expect(scheduler).not.toContain("errorCode: error instanceof Error ? error.name : 'UnknownError'");
    expect(scheduler).toContain('...safeContentLogErrorFields(error)');
    expect(scheduler).not.toContain("logger.warn({ err }, 'Failed to seed default content reference channels')");
    expect(scheduler).not.toContain("logger.info({ msg }, '[scheduler] book library seed progress')");
    expect(scheduler).toContain("failureDetailPolicy: 'machine_only'");
    expect(pythonProxy).toContain('_STABLE_AI_BUDGET_MESSAGES');
    expect(pythonProxy).toContain('_STABLE_LOCAL_INFERENCE_MESSAGES');
    expect(pythonProxy).toContain('_safe_ai_budget_details(error.get("details"))');
    expect(pythonProxy).toContain('_safe_local_inference_details(error.get("details"), response.status_code)');
    expect(pythonProxy).not.toContain('message = error.get("message")');
    expect(pythonProxy).not.toContain('details=details if isinstance(details, dict) else {}');
    expect(planOrchestration).not.toContain('logger.warn({ err');
    expect(planOrchestration).not.toContain('{ err, userId');
  });

  it('keeps cancellation fences immediately before canonical Content writes', () => {
    const discovery = read('src/services/content-discovery.ts');
    const workflow = read('src/services/content-workflow.ts');
    const scriptRoutes = read('src/api/routes/content-script-routes.ts');
    const agentRoutes = read('src/api/routes/content-agent-job-routes.ts');
    const agentJobs = read('src/services/content-agent-jobs.ts');

    expect(discovery).toMatch(
      /await isDuplicateIdea[\s\S]{0,300}throwIfContentDiscoveryCancelled\(options\.abortSignal\);/,
    );
    expect(discovery).toMatch(
      /for \(const title of eligibleIdeas\)[\s\S]{0,200}throwIfContentDiscoveryCancelled\(options\.abortSignal\);[\s\S]{0,500}captureDiscoveredIdea/,
    );
    expect(workflow).toMatch(
      /getDb\(\)\.transaction\(\(\) => \{[\s\S]{0,350}rethrowContentWorkflowCancellation\(undefined, budgetContext\.abortSignal\);[\s\S]{0,250}storeTopicCandidates/,
    );
    expect(scriptRoutes).toMatch(
      /throwIfContentScriptRequestCancelled\(requestAbortController\.signal\);\s*const reservation = reserveContentScriptSaveRequest/,
    );
    expect(scriptRoutes).toMatch(
      /const persistAcceptedTokenArtifacts = [\s\S]{0,180}try \{\s*throwIfContentScriptRequestCancelled\(accountAbortSignal\);/,
    );
    expect(scriptRoutes).toMatch(
      /const captureSavedIdea = [\s\S]{0,220}try \{\s*throwIfContentScriptRequestCancelled\(accountAbortSignal\);/,
    );
    expect(scriptRoutes).toMatch(
      /buildResponse: \(transactionDb\) => \{\s*throwIfContentScriptRequestCancelled\(accountAbortSignal\);/,
    );
    expect(agentRoutes).toContain(
      "bindContentRequestCancellation(req, res, 'content_agent_job_run')",
    );
    expect(agentRoutes).toContain('abortSignal: requestCancellation!.signal');
    expect(agentRoutes).toContain('requestCancellation?.cleanup()');
    expect(agentJobs).toContain('abortSignal?: AbortSignal');
    expect(agentJobs).toContain('abortSignal: input.abortSignal');
    expect(agentJobs).toMatch(
      /const completed = db\.transaction\(\(\) => \{\s*throwIfContentAgentJobCancelled\(workflowAbortSignal\);/,
    );
    expect(agentJobs).toMatch(
      /return db\.transaction\(\(\) => \{\s*throwIfContentAgentJobCancelled\(abortSignal\);/,
    );
  });
});
