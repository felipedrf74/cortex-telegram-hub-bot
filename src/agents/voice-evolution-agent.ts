// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Voice Evolution Agent — compares AI-generated scripts against
 * actual published video transcripts to learn Felipe's true voice.
 *
 * Schedule: Monthly, 1st of month at 04:00
 *
 * Consumes: channel_dna, book_knowledge, pillar_performance (cross-agent), retention_pattern (cross-agent)
 * Produces: voice_pattern, voice_phrase_trend
 */

import Anthropic from '@anthropic-ai/sdk';
import { writeSignal, readSignals, logAgentRun } from '../services/intelligence-bus';
import { buildAgentContext } from '../services/cross-agent-learning';
import { getDb } from '../services/database';
import { config } from '../config';
import { logger } from '../utils/logger';
import { trackedCreate } from '../portal/anthropic-hook';
import { completeOneShotWithFallback } from '../services/gemini-provider';
import fs from 'fs';
import os from 'os';
import path from 'path';

const IDEAS_DIR = path.join(os.homedir(), 'Desktop', 'IDEAS', 'SCRIPTS');

const client = new Anthropic({ apiKey: config.anthropic.apiKey, maxRetries: 2 });

const ANALYSIS_PROMPT = `You are analyzing the voice evolution of Felipe, a Brazilian content creator.

Compare these AI-GENERATED scripts against Felipe's ACTUAL published video transcripts.

AI-GENERATED SCRIPTS:
{scripts}

PUBLISHED VIDEO TRANSCRIPTS:
{transcripts}

BOOK KNOWLEDGE (extracted from books Felipe reads — frameworks, vocabulary, and techniques):
{book_knowledge}

Analyze and return a JSON object with:
{{
  "additions": [
    {{
      "pattern": "Short description of what Felipe adds",
      "examples": ["Specific text he added"],
      "frequency": "often|sometimes|rare",
      "category": "anecdote|argument|humor|data|reference|transition"
    }}
  ],
  "removals": [
    {{
      "pattern": "What Felipe consistently removes/shortens",
      "examples": ["Original text he cut"],
      "category": "filler|formal|repetitive|off_brand"
    }}
  ],
  "rephrasing": [
    {{
      "original": "How the AI wrote it",
      "felipe_version": "How Felipe actually said it",
      "insight": "What this tells us about his voice"
    }}
  ],
  "recurring_phrases": [
    {{
      "phrase": "Exact phrase Felipe repeats",
      "context": "When he uses it",
      "count": 3
    }}
  ],
  "book_influences": [
    {{
      "book_or_concept": "Name of book or concept from book knowledge",
      "how_it_appears": "How this concept shows up in Felipe's scripts or transcripts",
      "adoption_level": "integrated|emerging|absent"
    }}
  ],
  "voice_summary": "2-3 sentences describing Felipe's actual voice vs the AI-generated voice, including any book influences detected"
}}

If transcripts are limited, analyze the scripts against the creator profile instead and note what's missing.
If book knowledge is available, identify which concepts Felipe has integrated into his natural voice vs. which remain absent.
Return ONLY valid JSON, no markdown.`;

// ── Main Agent Runner ────────────────────────────────────────────────

export async function runVoiceEvolutionAgent(): Promise<void> {
  const start = Date.now();
  let signalsProduced = 0;
  let signalsConsumed = 0;

  try {
    const db = getDb();

    // Collect generated scripts from last 30 days
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const pipelineScripts = db.prepare(`
      SELECT topic_title, script_path FROM content_pipeline
      WHERE stage IN ('scripted', 'filming', 'editing', 'published')
        AND created_at > ?
      ORDER BY created_at DESC
      LIMIT 10
    `).all(thirtyDaysAgo) as any[];

    // Read script files
    const scripts: { topic: string; text: string }[] = [];
    for (const entry of pipelineScripts) {
      if (entry.script_path && fs.existsSync(entry.script_path)) {
        try {
          // For .docx files we can't easily read — just note the path
          scripts.push({
            topic: entry.topic_title,
            text: `[Script file: ${path.basename(entry.script_path)}]`,
          });
        } catch { /* skip unreadable */ }
      }
    }

    // Also check for .txt or raw script files in IDEAS/SCRIPTS
    if (fs.existsSync(IDEAS_DIR)) {
      const files = fs.readdirSync(IDEAS_DIR)
        .filter(f => f.endsWith('.txt'))
        .sort()
        .slice(-10);

      for (const file of files) {
        try {
          const content = fs.readFileSync(path.join(IDEAS_DIR, file), 'utf-8');
          if (content.length > 100) {
            scripts.push({ topic: file, text: content.slice(0, 2000) });
          }
        } catch { /* skip */ }
      }
    }

    // Collect published video transcripts
    const transcripts = db.prepare(`
      SELECT title, full_text FROM video_transcripts
      WHERE created_at > ?
      ORDER BY created_at DESC
      LIMIT 10
    `).all(thirtyDaysAgo) as any[];

    // Consume channel DNA for reference
    const dnaSignals = readSignals('voice-evolution', ['channel_dna'], 20);
    signalsConsumed += dnaSignals.length;

    // Consume book knowledge — frameworks, vocabulary, techniques from books Felipe reads
    const bookSignals = readSignals('voice-evolution', ['book_knowledge'], 10);
    signalsConsumed += bookSignals.length;

    // Cross-agent learning: consume performance data to focus on high-performing content
    const peerContext = buildAgentContext('voice-evolution');
    signalsConsumed += peerContext.signalsConsumed;

    // If we have neither scripts nor transcripts, graceful skip
    if (scripts.length === 0 && transcripts.length === 0) {
      logger.info('Voice Evolution: No scripts or transcripts from last 30 days. Skipping.');
      logAgentRun('voice-evolution', 'skipped', 0, signalsConsumed, Date.now() - start,
        'No scripts or transcripts available');
      return;
    }

    // Build context for Claude analysis
    const scriptsBlock = scripts.length > 0
      ? scripts.map(s => `=== ${s.topic} ===\n${s.text}`).join('\n\n')
      : 'No generated scripts available for this period.';

    const transcriptsBlock = transcripts.length > 0
      ? transcripts.map((t: any) => `=== ${t.title} ===\n${(t.full_text || '').slice(0, 2000)}`).join('\n\n')
      : 'No published transcripts available for this period. Analyze scripts against the creator profile instead.';

    // Build book knowledge context
    const bookKnowledgeBlock = bookSignals.length > 0
      ? bookSignals.map(s => {
          const p = s.payload as any;
          const title = p.book_title || p.title || 'Unknown';
          const concepts = p.key_concepts || p.frameworks || p.techniques || [];
          const summary = p.summary || p.description || '';
          return `=== ${title} ===\n${summary}\nKey concepts: ${Array.isArray(concepts) ? concepts.join(', ') : concepts}`;
        }).join('\n\n')
      : 'No book knowledge available. Skip the book_influences section.';

    const prompt = ANALYSIS_PROMPT
      .replace('{scripts}', scriptsBlock)
      .replace('{transcripts}', transcriptsBlock)
      .replace('{book_knowledge}', bookKnowledgeBlock);

    // Gemini-first deep analysis with Sonnet fallback. This is a low-frequency
    // call (~weekly) but each invocation is large (~4K output tokens). Voice
    // pattern extraction works well on gemini-2.5-flash for this prompt shape.
    const { text: voiceText } = await completeOneShotWithFallback(
      '',  // no system prompt — instructions are in the user prompt
      prompt,
      'voice_evolution',
      async () => {
        const response = await trackedCreate(client, {
          model: config.anthropic.model,
          max_tokens: 4096,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.3,
        }, 'voice_evolution');
        return response.content
          .filter((b): b is Anthropic.TextBlock => b.type === 'text')
          .map(b => b.text)
          .join('');
      },
      { maxTokens: 4096, temperature: 0.3 },
    );

    let text = voiceText;

    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

    let analysis: any;
    try {
      analysis = JSON.parse(text);
    } catch {
      logger.warn('Voice Evolution: Claude returned non-JSON, writing raw observation');
      analysis = { voice_summary: text.slice(0, 500), additions: [], removals: [], rephrasing: [], recurring_phrases: [] };
    }

    // Write voice_pattern signals
    if (analysis.additions?.length > 0) {
      writeSignal({
        source_agent: 'voice-evolution',
        signal_type: 'voice_pattern',
        payload: {
          observation: 'content_additions',
          description: `Felipe adds ${analysis.additions.length} types of content not in generated scripts`,
          patterns: analysis.additions,
          strength: analysis.additions.filter((a: any) => a.frequency === 'often').length / Math.max(1, analysis.additions.length),
          first_detected: new Date().toISOString().slice(0, 10),
          category: 'addition_pattern',
        },
      });
      signalsProduced++;
    }

    if (analysis.removals?.length > 0) {
      writeSignal({
        source_agent: 'voice-evolution',
        signal_type: 'voice_pattern',
        payload: {
          observation: 'content_removals',
          description: `Felipe removes ${analysis.removals.length} types of content from generated scripts`,
          patterns: analysis.removals,
          strength: 0.7,
          first_detected: new Date().toISOString().slice(0, 10),
          category: 'removal_pattern',
        },
      });
      signalsProduced++;
    }

    if (analysis.rephrasing?.length > 0) {
      writeSignal({
        source_agent: 'voice-evolution',
        signal_type: 'voice_pattern',
        payload: {
          observation: 'voice_rephrasing',
          description: 'How Felipe rephrases AI-generated text to match his voice',
          examples: analysis.rephrasing.slice(0, 5),
          strength: 0.8,
          first_detected: new Date().toISOString().slice(0, 10),
          category: 'rephrasing_pattern',
        },
      });
      signalsProduced++;
    }

    // Write recurring phrases as voice_phrase_trend
    if (analysis.recurring_phrases?.length > 0) {
      for (const phrase of analysis.recurring_phrases.slice(0, 5)) {
        writeSignal({
          source_agent: 'voice-evolution',
          signal_type: 'voice_phrase_trend',
          payload: {
            phrase: phrase.phrase,
            context: phrase.context,
            frequency: phrase.count || 1,
            detected_at: new Date().toISOString(),
          },
        });
        signalsProduced++;
      }
    }

    // Write book influence signals (tracks how book concepts enter Felipe's voice)
    if (analysis.book_influences?.length > 0) {
      writeSignal({
        source_agent: 'voice-evolution',
        signal_type: 'voice_pattern',
        payload: {
          observation: 'book_voice_influence',
          description: `${analysis.book_influences.filter((b: any) => b.adoption_level === 'integrated').length} book concepts integrated into voice`,
          influences: analysis.book_influences,
          strength: analysis.book_influences.filter((b: any) => b.adoption_level === 'integrated').length / Math.max(1, analysis.book_influences.length),
          first_detected: new Date().toISOString().slice(0, 10),
          category: 'book_influence',
        },
      });
      signalsProduced++;
    }

    // Voice summary signal
    if (analysis.voice_summary) {
      writeSignal({
        source_agent: 'voice-evolution',
        signal_type: 'voice_pattern',
        payload: {
          observation: 'monthly_voice_summary',
          description: analysis.voice_summary,
          strength: 0.9,
          first_detected: new Date().toISOString().slice(0, 10),
          category: 'voice_summary',
        },
      });
      signalsProduced++;
    }

    const summary = `Voice Evolution: analyzed ${scripts.length} scripts + ${transcripts.length} transcripts + ${bookSignals.length} book insights. ${signalsProduced} voice patterns detected.`;
    logAgentRun('voice-evolution', 'success', signalsProduced, signalsConsumed, Date.now() - start);
    logger.info(summary);
  } catch (err: any) {
    logAgentRun('voice-evolution', 'error', signalsProduced, signalsConsumed, Date.now() - start, err.message);
    logger.error({ err }, 'Voice Evolution Agent failed');
    throw err;
  }
}
