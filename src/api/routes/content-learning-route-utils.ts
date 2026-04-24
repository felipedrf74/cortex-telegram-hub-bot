// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { buildGenerationMeta } from './content-generation-meta';

function mapCandidate(candidate: any) {
  return {
    feedbackId: candidate.feedbackId,
    title: candidate.title,
    niche: candidate.niche,
    hookIdea: candidate.hookIdea,
    whyNow: candidate.whyNow,
    angleTag: candidate.angleTag || null,
  };
}

export function buildGeneratedTopicCandidatesResponse(result: any, format: string, sourceJob: string, startMs: number) {
  const candidates = result?.candidates || [];
  return {
    format: result?.format || format,
    sourceJob: result?.sourceJob || sourceJob,
    dayLabel: result?.dayLabel || null,
    count: candidates.length,
    candidates: candidates.map(mapCandidate),
    generation: buildGenerationMeta({
      mode: 'standard',
      startMs,
      provider: 'gemini-flash',
      researchUsed: false,
    }),
  };
}

export function buildPendingTopicsResponse(rows: any[]) {
  return {
    count: rows.length,
    topics: rows.map((row: any) => ({
      feedbackId: row.id,
      title: row.topic,
      niche: row.niche,
      format: row.format,
      hookIdea: row.hook_idea,
      whyNow: row.why_now,
      angleTag: row.angle_tag,
      sourceJob: row.source_job,
      createdAt: row.created_at,
    })),
  };
}

export function buildWeeklyPackageResponse(result: any, startMs: number) {
  return {
    youtube: {
      count: result.youtube.length,
      candidates: result.youtube.map(mapCandidate),
    },
    reels: {
      count: result.reels.length,
      candidates: result.reels.map(mapCandidate),
    },
    generation: buildGenerationMeta({
      mode: 'standard',
      startMs,
      provider: 'gemini-flash',
      researchUsed: false,
    }),
  };
}

export function buildTasteProfileResponse(rows: Array<{ topic: string; niche: string; sentiment: string }>) {
  const approved = rows.filter((row) => row.sentiment === 'approved');
  const rejected = rows.filter((row) => row.sentiment === 'rejected');
  const nicheBreakdown: Record<string, { approved: number; rejected: number }> = {};

  for (const row of rows) {
    const niche = row.niche || 'general';
    if (!nicheBreakdown[niche]) nicheBreakdown[niche] = { approved: 0, rejected: 0 };
    nicheBreakdown[niche][row.sentiment as 'approved' | 'rejected']++;
  }

  return {
    totalFeedback: rows.length,
    approved: approved.length,
    rejected: rejected.length,
    approvalRate: rows.length > 0 ? Math.round((approved.length / rows.length) * 100) : 0,
    nicheBreakdown,
    recentApproved: approved.slice(0, 5).map((row) => ({ title: row.topic, niche: row.niche })),
    recentRejected: rejected.slice(0, 5).map((row) => ({ title: row.topic, niche: row.niche })),
  };
}

export function buildLearnedPatternsResponse(patterns: any[]) {
  return {
    count: patterns.length,
    patterns: patterns.map((pattern: any) => ({
      id: pattern.id,
      category: pattern.category,
      pattern: pattern.patternText,
      examples: pattern.examples,
      confidence: pattern.confidence,
      frequency: pattern.frequency,
      sourceAgent: pattern.sourceAgent,
      firstDetected: pattern.firstDetectedAt,
      lastSeen: pattern.lastSeenAt,
    })),
  };
}

export function buildRecentScriptsResponse(scripts: any[]) {
  return {
    count: scripts.length,
    scripts: scripts.map((script: any) => ({
      id: script.id,
      topic: script.topic,
      format: script.format,
      hook: script.hook,
      titleOptions: script.titleOptions,
      estimatedDuration: script.estimatedDuration,
      niche: script.niche,
      createdAt: script.createdAt,
      preview: script.scriptText?.slice(0, 300) ?? null,
    })),
  };
}
