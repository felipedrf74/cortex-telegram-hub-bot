// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Video Study Service
 *
 * Deep-analyzes individual YouTube videos by combining transcript extraction
 * with Claude analysis. Produces:
 *   - Opening-sequence breakdown (transcript-derived words, pacing, technique)
 *   - Content structure (section-by-section with timestamps)
 *   - Key moments (high-signal or quotable moments with timestamps)
 *   - Content ideas (inspired by this video, adapted for the authenticated creator)
 *   - Reel/Short cuts (suggested clip points with timestamps)
 *
 * Used by:
 *   - /studyvideo <url> — Full video study
 *   - /transcribe <url> — Just get the transcript
 *   - Channel learner — Deep analysis of top-performing videos
 */
import Anthropic from '@anthropic-ai/sdk';
import { createHash } from 'node:crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } from 'docx';
import { config } from '../config';
import { logger } from '../utils/logger';
import { trackedCreate } from '../portal/anthropic-hook';
import { completeOneShotWithFallback } from './gemini-provider';
import { withAiBudgetReservation } from './cost-guardrail';
import { pushEvent } from '../portal/telemetry';
import { uploadToDrive } from './google-drive';
import {
  fetchTranscript,
  extractVideoId,
  formatTranscriptTimestamped,
  getHookSection,
  splitIntoSections,
  stripMarkupTagsToPlainText,
  type TranscriptResult,
} from './youtube-transcript';
import { getDb } from './database';
import {
  buildCreatorPromptContext,
  loadCreatorPromptContextForUser,
  type CreatorPromptContext,
} from './content-profile-prompt-context';
import type { ContentCreatorProfile } from '../state/content-creator-profile';
import {
  contentScopeForInsert,
  contentScopeParams,
  contentScopePredicate,
  ensureContentTenantScopeColumns,
} from './content-tenant-scope';

// Bounded transcript-extraction window for storage and prompt economy only.
// This is not a claim about how long an effective opening should last.
const VIDEO_STUDY_OPENING_SAMPLE_SECONDS = 30;

const client = new Anthropic({
  apiKey: config.anthropic.apiKey,
  // A study has no provider-level replay identity, so an SDK transport retry
  // could duplicate a paid request whose outcome is ambiguous.
  maxRetries: 0,
});

function safeVideoStudyErrorName(error: unknown): string {
  const candidate = error instanceof Error && error.name ? error.name : typeof error;
  return candidate.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 80) || 'UnknownError';
}

function videoStudyInputFingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

// ─── Types ──────────────────────────────────────────────────────────

export interface VideoStudyResult {
  videoId: string;
  title: string;
  channelName: string;
  transcriptAvailable: boolean;
  transcriptLanguage: string;
  transcriptLength: number;
  hookAnalysis: string;
  structureBreakdown: string;
  keyMoments: string[];
  contentIdeas: string[];
  reelCuts: ReelCut[];
  fullAnalysis: string;       // Complete Claude analysis text
  durationMs: number;
}

export interface ReelCut {
  startTimestamp: string;     // "2:15"
  endTimestamp: string;       // "2:45"
  description: string;        // What this clip covers
  hookSuggestion: string;     // Hook text for the reel
  estimatedDuration: string;  // "30s", "45s"
}

// ─── Transcript Cache (SQLite) ───────────────────────────────────────

function getCachedTranscript(videoId: string, userId = 0, tenantId: number | null = userId): {
  full_text: string;
  hook_text: string;
  title: string;
  channel_name: string;
  language: string;
  duration_seconds: number;
} | null {
  try {
    const db = getDb();
    ensureContentTenantScopeColumns(db);
    if (userId > 0) {
      return db.prepare(
        `SELECT full_text, hook_text, title, channel_name, language, duration_seconds FROM video_transcripts
         WHERE video_id = ? AND ${contentScopePredicate()}
         ORDER BY updated_at DESC LIMIT 1`,
      ).get(videoId, ...contentScopeParams(userId, tenantId)) as any;
    }
    return db.prepare(
      `SELECT full_text, hook_text, title, channel_name, language, duration_seconds FROM video_transcripts
       WHERE video_id = ? AND user_id = 0
       ORDER BY updated_at DESC LIMIT 1`,
    ).get(videoId) as any;
  } catch {
    return null;
  }
}

function cacheTranscript(
  transcript: TranscriptResult,
  refChannelId?: number | null,
  source = 'manual',
  userId = 0,
  tenantId: number | null = userId,
): void {
  try {
    const db = getDb();
    ensureContentTenantScopeColumns(db);
    const scope = contentScopeForInsert(userId, tenantId);
    db.prepare(`
      INSERT INTO video_transcripts
        (video_id, title, channel_name, language, full_text, hook_text,
         duration_seconds, is_auto_generated, segment_count, char_count,
         ref_channel_id, source, user_id, tenant_id, owner_user_id, visibility_scope,
         lifecycle_state, scope_status, created_by, updated_by, audit_metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, video_id) DO UPDATE SET
        full_text = excluded.full_text,
        hook_text = excluded.hook_text,
        tenant_id = excluded.tenant_id,
        owner_user_id = excluded.owner_user_id,
        visibility_scope = excluded.visibility_scope,
        lifecycle_state = excluded.lifecycle_state,
        scope_status = excluded.scope_status,
        updated_by = excluded.updated_by,
        audit_metadata_json = excluded.audit_metadata_json,
        updated_at = datetime('now')
    `).run(
      transcript.videoId,
      transcript.title,
      transcript.channelName,
      transcript.language,
      transcript.fullText,
      getHookSection(transcript.segments, VIDEO_STUDY_OPENING_SAMPLE_SECONDS),
      transcript.durationSeconds,
      transcript.isAutoGenerated ? 1 : 0,
      transcript.segments.length,
      transcript.fullText.length,
      refChannelId ?? null,
      source,
      userId,
      scope.tenantId,
      scope.ownerUserId,
      scope.visibilityScope,
      scope.lifecycleState,
      scope.scopeStatus,
      scope.createdBy,
      scope.updatedBy,
      scope.auditMetadataJson,
    );
  } catch (err) {
    logger.warn(
      {
        errorName: safeVideoStudyErrorName(err),
        videoFingerprint: videoStudyInputFingerprint(transcript.videoId),
      },
      'Failed to cache transcript',
    );
  }
}

function cacheStudyResult(videoId: string, result: VideoStudyResult, userId = 0, tenantId: number | null = userId): void {
  try {
    const db = getDb();
    ensureContentTenantScopeColumns(db);
    const scope = contentScopeForInsert(userId, tenantId);
    const transcriptRow = db.prepare(
      `SELECT id FROM video_transcripts WHERE video_id = ? AND user_id = ? ORDER BY updated_at DESC LIMIT 1`,
    ).get(videoId, userId) as { id: number } | undefined;

    db.prepare(`
      INSERT INTO video_studies
        (video_id, transcript_id, study_type, analysis_json,
         hook_analysis, structure_breakdown, key_moments, content_ideas, reel_cuts,
         user_id, tenant_id, owner_user_id, visibility_scope, lifecycle_state,
         scope_status, created_by, updated_by, audit_metadata_json)
      VALUES (?, ?, 'full', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      videoId,
      transcriptRow?.id ?? null,
      JSON.stringify(result),
      result.hookAnalysis,
      result.structureBreakdown,
      JSON.stringify(result.keyMoments),
      JSON.stringify(result.contentIdeas),
      JSON.stringify(result.reelCuts),
      userId,
      scope.tenantId,
      scope.ownerUserId,
      scope.visibilityScope,
      scope.lifecycleState,
      scope.scopeStatus,
      scope.createdBy,
      scope.updatedBy,
      scope.auditMetadataJson,
    );
  } catch (err) {
    logger.warn(
      { errorName: safeVideoStudyErrorName(err), videoFingerprint: videoStudyInputFingerprint(videoId) },
      'Failed to cache study result',
    );
  }
}

// ─── Claude Analysis Prompts ─────────────────────────────────────────

export function buildVideoStudySystemPrompt(profile?: Partial<ContentCreatorProfile> | null): string {
  const creator = buildCreatorPromptContext(profile);
  return buildVideoStudySystemPromptFromContext(creator);
}

function buildVideoStudySystemPromptFromContext(creator: CreatorPromptContext): string {
  return `You are a world-class content strategist analyzing a YouTube video's transcript to extract actionable insights.

CREATOR CONTEXT:
${creator.block}

You will receive the video's full transcript with timestamps. Analyze it thoroughly and provide:

1. **HOOK ANALYSIS** (the observed opening sequence; use transcript timestamps rather than assuming a universal duration)
   - Exact opening words/phrases
   - What psychological trigger is used (curiosity, shock, identity, urgency, story)
   - Pacing: how fast do they get to the point?
   - Visual cues implied (if they reference what's on screen)
   - Grade: A/B/C/D as a review hypothesis, with an evidence-based explanation

2. **CONTENT STRUCTURE**
   - Section-by-section breakdown with timestamps: [0:00-2:30] Introduction, [2:30-5:00] Point 1, etc.
   - How transitions between sections are handled
   - Potential attention frictions (for example long tangents or slow sections), labeled as hypotheses unless retention evidence is supplied
   - Potentially strong moments (for example stories, reveals, or useful contrasts), labeled as hypotheses unless retention evidence is supplied

3. **KEY MOMENTS** (up to 8 evidence-supported moments; stop early rather than padding)
   - Timestamp + exact quote or paraphrase
   - Why it's notable (observed audience response when supplied, strong insight, emotional peak, or quotable phrasing)
   - How it could be adapted for ${creator.language} content

4. **CONTENT IDEAS** (up to 5 source-grounded ideas; stop early rather than padding)
   - Ideas INSPIRED by this video that the authenticated creator could create
   - Each with: title in ${creator.language}, format (YouTube/Reel/Short), hook, unique angle
   - These should NOT be copies — they should be the creator's own take using their saved pillars, audience, and brand voice

5. **REEL/SHORT CUTS** (up to 5 coherent suggested clips; stop early rather than padding)
   - Start timestamp → End timestamp
   - Description of the clip
   - Suggested hook text in ${creator.language} for posting as a standalone Reel/Short
   - Estimated duration derived from the selected timestamps. Use an explicit requested/tenant target when supplied; otherwise do not claim a universal ideal length

FORMAT: Return valid JSON:
{
  "hook_analysis": "Detailed transcript-timestamped opening-sequence breakdown...",
  "structure_breakdown": "[0:00-1:30] Hook: Opens with...\n[1:30-4:00] Point 1: ...",
  "key_moments": [
    "[2:15] 'Exact quote or paraphrase' — Why it's notable...",
    ...
  ],
  "content_ideas": [
    "📹 TITLE — Format: YouTube — Hook: '...' — Angle: ...",
    ...
  ],
  "reel_cuts": [
    {
      "startTimestamp": "2:15",
      "endTimestamp": "2:42",
      "description": "What this clip covers",
      "hookSuggestion": "Hook text in the target language for posting as standalone reel",
      "estimatedDuration": "27s"
    }
  ]
}

RULES:
- Be specific — cite exact timestamps and quotes from the transcript
- Content ideas MUST follow the creator context language, audience, and pillars above
- Reel cuts should be self-contained (make sense without the full video)
- Treat opening, pacing, clip selection, and likely audience response as bounded review hypotheses unless the supplied transcript, metrics, request, or tenant configuration establishes them
- Focus on ACTIONABLE insights — what can the authenticated creator actually use?
- If transcript is auto-generated, account for possible transcription errors`;
}

/**
 * Full video study: transcript + deep Claude analysis.
 */
export async function studyVideo(
  videoIdOrUrl: string,
  options?: { skipCache?: boolean; userId?: number; tenantId?: number; creatorProfile?: Partial<ContentCreatorProfile> },
): Promise<VideoStudyResult> {
  const startTime = Date.now();
  const scopedUserId = Number.isFinite(options?.userId) && Number(options?.userId) > 0 ? Number(options?.userId) : 0;
  const scopedTenantId = Number.isFinite(options?.tenantId) && Number(options?.tenantId) > 0 ? Number(options?.tenantId) : scopedUserId;
  const videoId = extractVideoId(videoIdOrUrl);
  if (!videoId) {
    throw new Error('Invalid YouTube video URL or ID');
  }

  // Check cache first
  if (!options?.skipCache) {
    const cached = getCachedStudy(videoId, scopedUserId, scopedTenantId);
    if (cached) {
      logger.info(
        { videoFingerprint: videoStudyInputFingerprint(videoId) },
        'Returning cached video study',
      );
      return cached;
    }
  }

  // Fetch transcript
  const transcript = await fetchTranscript(videoId);
  if (!transcript || transcript.fullText.length < 100) {
    throw new Error(
      `No transcript available for this video (${videoId}). The video may not have captions enabled.`,
    );
  }

  // Cache transcript
  cacheTranscript(transcript, null, 'study', scopedUserId, scopedTenantId);

  // Prepare transcript for Claude (truncate very long ones)
  const maxTranscriptChars = 25000; // ~7K tokens, leaves room for analysis
  const transcriptText = transcript.fullText.length > maxTranscriptChars
    ? transcript.fullText.substring(0, maxTranscriptChars) + '\n\n[TRANSCRIPT TRUNCATED — video is very long]'
    : transcript.fullText;

  const timestampedText = formatTranscriptTimestamped(transcript.segments);
  const hookText = getHookSection(transcript.segments, VIDEO_STUDY_OPENING_SAMPLE_SECONDS);
  const sections = splitIntoSections(transcript.segments);
  const creatorContext = options?.creatorProfile
    ? buildCreatorPromptContext(options.creatorProfile)
    : loadCreatorPromptContextForUser(scopedUserId, scopedTenantId);
  const studySystemPrompt = buildVideoStudySystemPromptFromContext(creatorContext);

  // Build context for Claude
  const prompt = `Analyze this YouTube video:

📺 **"${transcript.title}"** by ${transcript.channelName}
⏱ Duration: ${Math.floor(transcript.durationSeconds / 60)}:${(transcript.durationSeconds % 60).toString().padStart(2, '0')}
🗣️ Language: ${transcript.language} ${transcript.isAutoGenerated ? '(auto-generated captions)' : '(manual captions)'}

BOUNDED OPENING TRANSCRIPT SAMPLE (analysis excerpt, not a hook-duration rule):
${hookText}

FULL TRANSCRIPT (with timestamps):
${timestampedText.substring(0, maxTranscriptChars)}

Provide the complete study analysis.`;

  // Gemini-first: configuration fallthrough is allowed before dispatch, but a
  // dispatched provider failure is terminal because the study has no replay ID.
  const { text: studyText } = await withAiBudgetReservation({
    userId: scopedUserId,
    requestSource: scopedUserId > 0 ? 'interactive' : 'system',
    baseCategory: 'video_study',
  }, () => completeOneShotWithFallback(
    studySystemPrompt,
    prompt,
    'video_study',
    async () => {
      const response = await trackedCreate(client, {
          model: config.anthropic.model, // Sonnet for quality
          max_tokens: 4096,
          system: studySystemPrompt,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.4,
      }, 'video_study', { userId: scopedUserId, tenantId: scopedTenantId });
      return response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
    },
    {
      maxTokens: 4096,
      temperature: 0.4,
      maxRetries: 0,
      userId: scopedUserId,
      tenantId: scopedTenantId,
      allowFallbackAfterProviderFailure: false,
    },
  ));

  let text = studyText;

  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  let analysis: any;
  try {
    analysis = JSON.parse(text);
  } catch {
    // If JSON parsing fails, treat the whole response as the analysis
    analysis = {
      hook_analysis: text,
      structure_breakdown: '',
      key_moments: [],
      content_ideas: [],
      reel_cuts: [],
    };
  }

  const result: VideoStudyResult = {
    videoId,
    title: transcript.title,
    channelName: transcript.channelName,
    transcriptAvailable: true,
    transcriptLanguage: transcript.language,
    transcriptLength: transcript.fullText.length,
    hookAnalysis: analysis.hook_analysis || '',
    structureBreakdown: analysis.structure_breakdown || '',
    keyMoments: Array.isArray(analysis.key_moments) ? analysis.key_moments : [],
    contentIdeas: Array.isArray(analysis.content_ideas) ? analysis.content_ideas : [],
    reelCuts: Array.isArray(analysis.reel_cuts) ? analysis.reel_cuts : [],
    fullAnalysis: text,
    durationMs: Date.now() - startTime,
  };

  // Cache result
  cacheStudyResult(videoId, result, scopedUserId, scopedTenantId);

  pushEvent({
    ts: new Date().toISOString(),
    type: 'job',
    summary: `Video study ${videoStudyInputFingerprint(videoId)} completed: ${result.contentIdeas.length} ideas, ${result.reelCuts.length} reel cuts`,
  });

  return result;
}

/**
 * Quick transcript-only fetch (no Claude analysis).
 */
export async function getTranscript(videoIdOrUrl: string): Promise<TranscriptResult | null> {
  const videoId = extractVideoId(videoIdOrUrl);
  if (!videoId) return null;

  // Check cache
  const cached = getCachedTranscript(videoId);
  if (cached) {
    return {
      videoId,
      title: cached.title,
      channelName: cached.channel_name,
      language: cached.language,
      segments: [], // Not stored in cache (too large)
      fullText: cached.full_text,
      durationSeconds: cached.duration_seconds,
      isAutoGenerated: false,
    };
  }

  const transcript = await fetchTranscript(videoId);
  if (transcript) {
    cacheTranscript(transcript, null, 'manual');
  }
  return transcript;
}

/**
 * Get cached study result (if exists).
 */
function getCachedStudy(videoId: string, userId = 0, tenantId: number | null = userId): VideoStudyResult | null {
  try {
    const db = getDb();
    ensureContentTenantScopeColumns(db);
    const row = userId > 0
      ? db.prepare(
        `SELECT analysis_json FROM video_studies
         WHERE video_id = ? AND ${contentScopePredicate()}
         ORDER BY created_at DESC LIMIT 1`,
      ).get(videoId, ...contentScopeParams(userId, tenantId)) as { analysis_json: string } | undefined
      : db.prepare(
        'SELECT analysis_json FROM video_studies WHERE video_id = ? AND user_id = 0 ORDER BY created_at DESC LIMIT 1',
      ).get(videoId) as { analysis_json: string } | undefined;

    if (!row) return null;
    return JSON.parse(row.analysis_json);
  } catch {
    return null;
  }
}

// ─── Batch Study for Channel Learner ─────────────────────────────────

/**
 * Fetch transcripts for the top N videos of a channel (by view count)
 * and extract deeper patterns including exact hook phrases, transitions,
 * storytelling beats, and pacing.
 *
 * Called from channel-learner to enrich pattern extraction.
 */
export async function deepAnalyzeTopVideos(
  _channelName: string,
  videos: { videoId: string; title: string; viewCount: number }[],
  topN = 5,
  userId = 0,
  tenantId: number | null = userId,
  abortSignal?: AbortSignal,
): Promise<{
  transcriptCount: number;
  deepPatterns: string;       // Formatted for injection into the pattern extraction prompt
}> {
  const throwIfAborted = (): void => {
    if (!abortSignal?.aborted) return;
    if (abortSignal.reason instanceof Error) throw abortSignal.reason;
    throw Object.assign(new Error('content_video_study_cancelled'), {
      name: 'AbortError',
      code: 'CONTENT_CLIENT_DISCONNECTED',
    });
  };
  const waitForDelay = async (delayMs: number): Promise<void> => {
    throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      function cleanup(): void {
        abortSignal?.removeEventListener('abort', abort);
      }
      function complete(): void {
        cleanup();
        resolve();
      }
      function abort(): void {
        clearTimeout(timer);
        cleanup();
        reject(abortSignal?.reason instanceof Error
          ? abortSignal.reason
          : Object.assign(new Error('content_video_study_cancelled'), {
            name: 'AbortError',
            code: 'CONTENT_CLIENT_DISCONNECTED',
          }));
      }
      timer = setTimeout(complete, delayMs);
      abortSignal?.addEventListener('abort', abort, { once: true });
    });
    throwIfAborted();
  };
  throwIfAborted();
  // Sort by views, take top N
  const topVideos = [...videos]
    .sort((a, b) => b.viewCount - a.viewCount)
    .slice(0, topN);

  logger.info({ topN, videoCount: topVideos.length }, 'Deep-analyzing top videos with transcripts');

  const transcripts: { title: string; hookText: string; fullText: string }[] = [];

  for (const v of topVideos) {
    try {
      // Check cache first
      const cached = getCachedTranscript(v.videoId, userId, tenantId);
      if (cached) {
        transcripts.push({
          title: cached.title || v.title,
          hookText: cached.hook_text || '',
          fullText: cached.full_text.substring(0, 5000),
        });
        continue;
      }

      const transcript = await fetchTranscript(v.videoId, undefined, { abortSignal });
      if (transcript && transcript.fullText.length > 50) {
        cacheTranscript(transcript, null, 'channel_analysis', userId, tenantId);
        transcripts.push({
          title: transcript.title,
          hookText: getHookSection(transcript.segments, VIDEO_STUDY_OPENING_SAMPLE_SECONDS),
          fullText: transcript.fullText.substring(0, 5000),
        });
      }
    } catch (err) {
      throwIfAborted();
      logger.debug(
        {
          errorName: safeVideoStudyErrorName(err),
          videoFingerprint: videoStudyInputFingerprint(v.videoId),
        },
        'Transcript unavailable for top video',
      );
    }

    // Rate limit
    await waitForDelay(1500);
  }

  if (transcripts.length === 0) {
    return { transcriptCount: 0, deepPatterns: '' };
  }

  // Build a compact transcript summary for the pattern extractor
  const deepPatterns = transcripts.map((t, i) => {
    return `\n--- TRANSCRIPT ${i + 1}: "${t.title}" ---
OPENING SAMPLE (bounded transcript excerpt, not a hook-duration rule): ${t.hookText}
BODY (first ~5000 chars): ${t.fullText}`;
  }).join('\n');

  logger.info({ transcriptCount: transcripts.length }, 'Deep analysis transcripts prepared');

  return {
    transcriptCount: transcripts.length,
    deepPatterns,
  };
}

// ─── Telegram Formatters ─────────────────────────────────────────────

export function formatStudyResult(result: VideoStudyResult): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lines: string[] = [];

  lines.push(`📚 <b>Video Study: "${esc(result.title)}"</b>`);
  lines.push(`📺 ${esc(result.channelName)} · ${result.transcriptLanguage} · ${Math.round(result.transcriptLength / 1000)}K chars`);
  lines.push(`⏱ ${Math.round(result.durationMs / 1000)}s analysis time`);
  lines.push('');

  // Hook Analysis
  if (result.hookAnalysis) {
    lines.push(`🎣 <b>HOOK ANALYSIS</b>`);
    lines.push(esc(result.hookAnalysis.substring(0, 600)));
    lines.push('');
  }

  // Structure
  if (result.structureBreakdown) {
    lines.push(`🏗️ <b>CONTENT STRUCTURE</b>`);
    lines.push(esc(result.structureBreakdown.substring(0, 800)));
    lines.push('');
  }

  // Key Moments
  if (result.keyMoments.length > 0) {
    lines.push(`⭐ <b>KEY MOMENTS</b> (${result.keyMoments.length})`);
    for (const moment of result.keyMoments.slice(0, 5)) {
      lines.push(`  • ${esc(typeof moment === 'string' ? moment : JSON.stringify(moment))}`);
    }
    lines.push('');
  }

  // Content Ideas
  if (result.contentIdeas.length > 0) {
    lines.push(`💡 <b>CONTENT IDEAS</b> (${result.contentIdeas.length})`);
    for (const idea of result.contentIdeas) {
      lines.push(`  • ${esc(typeof idea === 'string' ? idea : JSON.stringify(idea))}`);
    }
    lines.push('');
  }

  // Reel Cuts
  if (result.reelCuts.length > 0) {
    lines.push(`🎬 <b>REEL/SHORT CUTS</b> (${result.reelCuts.length})`);
    for (const cut of result.reelCuts) {
      if (typeof cut === 'object' && cut.startTimestamp) {
        lines.push(`  ✂️ [${esc(cut.startTimestamp)} → ${esc(cut.endTimestamp)}] ${esc(cut.description)}`);
        if (cut.hookSuggestion) lines.push(`     🎣 "${esc(cut.hookSuggestion)}"`);
      } else {
        lines.push(`  ✂️ ${esc(String(cut))}`);
      }
    }
  }

  return lines.join('\n');
}

export function formatTranscriptMessage(transcript: TranscriptResult): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  let msg = `📝 <b>Transcript: "${esc(transcript.title)}"</b>\n`;
  msg += `📺 ${esc(transcript.channelName)} · ${transcript.language}${transcript.isAutoGenerated ? ' (auto)' : ''}\n`;
  msg += `⏱ ${Math.floor(transcript.durationSeconds / 60)}:${(transcript.durationSeconds % 60).toString().padStart(2, '0')} · ${transcript.segments.length} segments · ${Math.round(transcript.fullText.length / 1000)}K chars\n\n`;

  // Show timestamped text (truncated for Telegram)
  const timestamped = formatTranscriptTimestamped(transcript.segments);
  msg += esc(timestamped.substring(0, 3500));

  if (timestamped.length > 3500) {
    msg += '\n\n<i>... transcript truncated. Full text saved to cache.</i>';
  }

  return msg;
}

// ─── DOCX Export ─────────────────────────────────────────────────────

export const IDEAS_DIR = path.join(os.homedir(), 'Desktop', 'IDEAS');

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9_\-.\s]/g, '').replace(/\s+/g, '_').substring(0, 80);
}

/**
 * Save a transcript as a .docx Word file and return the file path.
 */
export async function saveTranscriptAsDocx(transcript: TranscriptResult, userId?: number): Promise<string> {
  const timestamped = formatTranscriptTimestamped(transcript.segments);

  const children: Paragraph[] = [
    new Paragraph({
      children: [new TextRun({ text: transcript.title, bold: true, size: 32 })],
      heading: HeadingLevel.HEADING_1,
    }),
    new Paragraph({
      children: [
        new TextRun({ text: `Channel: ${transcript.channelName}`, italics: true, size: 22 }),
        new TextRun({ text: `  |  Language: ${transcript.language}${transcript.isAutoGenerated ? ' (auto-generated)' : ''}`, italics: true, size: 22 }),
        new TextRun({ text: `  |  Duration: ${Math.floor(transcript.durationSeconds / 60)}:${(transcript.durationSeconds % 60).toString().padStart(2, '0')}`, italics: true, size: 22 }),
      ],
    }),
    new Paragraph({ text: '' }),
    new Paragraph({
      children: [new TextRun({ text: 'Full Transcript', bold: true, size: 28 })],
      heading: HeadingLevel.HEADING_2,
    }),
  ];

  // Add timestamped blocks
  for (const line of timestamped.split('\n')) {
    if (!line.trim()) continue;
    const tsMatch = line.match(/^\[(\d+:\d+)\]\s*(.*)/);
    if (tsMatch) {
      children.push(new Paragraph({
        children: [
          new TextRun({ text: `[${tsMatch[1]}] `, bold: true, size: 22, color: '666666' }),
          new TextRun({ text: tsMatch[2], size: 22 }),
        ],
        spacing: { after: 120 },
      }));
    } else {
      children.push(new Paragraph({ children: [new TextRun({ text: line, size: 22 })] }));
    }
  }

  const doc = new Document({
    sections: [{ children }],
  });

  const filename = `transcript_${sanitizeFilename(transcript.title)}_${transcript.videoId}.docx`;
  const dir = path.join(IDEAS_DIR, 'RESEARCH');
  const filePath = path.join(dir, filename);

  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(filePath, buffer);

  if (userId != null) uploadToDrive(userId, filePath, filename, 'RESEARCH').catch(() => {});

  logger.info(
    { videoFingerprint: videoStudyInputFingerprint(transcript.videoId) },
    'Transcript saved as DOCX',
  );
  return filePath;
}

/**
 * Save a video study as a .docx Word file and return the file path.
 */
export async function saveStudyAsDocx(result: VideoStudyResult, userId?: number): Promise<string> {
  const children: Paragraph[] = [
    new Paragraph({
      children: [new TextRun({ text: `Video Study: ${result.title}`, bold: true, size: 32 })],
      heading: HeadingLevel.HEADING_1,
    }),
    new Paragraph({
      children: [
        new TextRun({ text: `Channel: ${result.channelName}`, italics: true, size: 22 }),
        new TextRun({ text: `  |  Language: ${result.transcriptLanguage}`, italics: true, size: 22 }),
      ],
    }),
    new Paragraph({ text: '' }),
  ];

  const addSection = (title: string, content: string) => {
    children.push(new Paragraph({
      children: [new TextRun({ text: title, bold: true, size: 28 })],
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 240 },
    }));
    for (const line of content.split('\n')) {
      children.push(new Paragraph({
        children: [new TextRun({ text: line, size: 22 })],
        spacing: { after: 80 },
      }));
    }
  };

  addSection('Opening-Sequence Analysis', result.hookAnalysis);
  addSection('Content Structure', result.structureBreakdown);

  if (result.keyMoments.length > 0) {
    addSection('Key Moments', result.keyMoments.map((m, i) => `${i + 1}. ${m}`).join('\n'));
  }
  if (result.contentIdeas.length > 0) {
    addSection('Content Ideas', result.contentIdeas.map((m, i) => `${i + 1}. ${m}`).join('\n'));
  }
  if (result.reelCuts.length > 0) {
    addSection('Reel/Short Cut Suggestions', result.reelCuts.map((m, i) => `${i + 1}. ${typeof m === 'string' ? m : `[${m.startTimestamp}-${m.endTimestamp}] ${m.description}`}`).join('\n'));
  }

  // Add full analysis as final section
  if (result.fullAnalysis) {
    addSection('Full Analysis', result.fullAnalysis);
  }

  const doc = new Document({
    sections: [{ children }],
  });

  const filename = `study_${sanitizeFilename(result.title)}_${result.videoId}.docx`;
  const dir = path.join(IDEAS_DIR, 'IDEAS');
  const filePath = path.join(dir, filename);

  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(filePath, buffer);

  if (userId != null) uploadToDrive(userId, filePath, filename, 'IDEAS').catch(() => {});

  logger.info(
    { videoFingerprint: videoStudyInputFingerprint(result.videoId) },
    'Video study saved as DOCX',
  );
  return filePath;
}

/**
 * Save a content script as a .docx Word file and return the file path.
 */
export async function saveScriptAsDocx(topic: string, scriptText: string, userId?: number): Promise<string> {
  const SCRIPTS_DIR = path.join(IDEAS_DIR, 'SCRIPTS');
  if (!fs.existsSync(SCRIPTS_DIR)) fs.mkdirSync(SCRIPTS_DIR, { recursive: true });

  // Parse script sections from the HTML/text response
  const cleanText = stripMarkupTagsToPlainText(scriptText);
  const lines = cleanText.split('\n');

  const children: Paragraph[] = [
    new Paragraph({
      children: [new TextRun({ text: topic, bold: true, size: 32 })],
      heading: HeadingLevel.HEADING_1,
    }),
    new Paragraph({
      children: [new TextRun({ text: `Generated: ${new Date().toISOString().slice(0, 10)}`, italics: true, size: 20, color: '888888' })],
    }),
    new Paragraph({ text: '' }),
  ];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      children.push(new Paragraph({ text: '' }));
      continue;
    }

    // Detect section headers (lines in ALL CAPS or with ━━━/───/--- dividers)
    const isHeader = /^[A-ZÁÉÍÓÚÀÂÊÔÃÕÇ\s\d\-—─━:()[\]]{4,}$/.test(trimmed) && trimmed.length < 80;
    const isDivider = /^[━─\-=]{3,}/.test(trimmed);

    if (isDivider) continue; // skip dividers, we use heading styles instead
    if (isHeader) {
      children.push(new Paragraph({
        children: [new TextRun({ text: trimmed, bold: true, size: 26 })],
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 240, after: 120 },
      }));
    } else if (trimmed.startsWith('▸') || trimmed.startsWith('•') || trimmed.startsWith('-')) {
      children.push(new Paragraph({
        children: [new TextRun({ text: trimmed, size: 22 })],
        spacing: { after: 80 },
        indent: { left: 360 },
      }));
    } else if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      // Stage directions like [pausa 2s]
      children.push(new Paragraph({
        children: [new TextRun({ text: trimmed, italics: true, size: 22, color: '666666' })],
        spacing: { after: 80 },
      }));
    } else {
      children.push(new Paragraph({
        children: [new TextRun({ text: trimmed, size: 22 })],
        spacing: { after: 100 },
      }));
    }
  }

  const doc = new Document({ sections: [{ children }] });

  const filename = `script_${sanitizeFilename(topic)}.docx`;
  const filePath = path.join(SCRIPTS_DIR, filename);

  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(filePath, buffer);

  if (userId != null) uploadToDrive(userId, filePath, filename, 'SCRIPTS').catch(() => {});

  logger.info({ topicChars: topic.length, scriptChars: scriptText.length }, 'Script saved as DOCX');
  return filePath;
}
