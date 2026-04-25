// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Regression tests for Python content-engine hardening (April 2026).
 *
 * These tests verify the structural fixes by reading the Python source
 * files and checking for the presence/absence of key patterns. This is
 * a pragmatic approach since the Python engine doesn't have its own
 * test framework — we validate that the code changes are correct by
 * inspecting the source.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const ENGINE_DIR = path.join(__dirname, '..', '..', 'content-engine', 'services');
const ENGINE_ROOT = path.join(__dirname, '..', '..', 'content-engine');

function readPy(relativePath: string): string {
  return fs.readFileSync(path.join(ENGINE_DIR, relativePath), 'utf-8');
}

function readEngineFile(relativePath: string): string {
  return fs.readFileSync(path.join(ENGINE_ROOT, relativePath), 'utf-8');
}

describe('Python claude_client.py — routes through TS AI proxy', () => {
  const src = readPy('claude_client.py');

  it('calls TS backend AI proxy instead of Anthropic directly', () => {
    expect(src).toContain('/api/v1/internal/ai-complete');
    // Must NOT call Anthropic API directly
    expect(src).not.toContain('api.anthropic.com');
  });

  it('does NOT import or use Anthropic API key', () => {
    expect(src).not.toContain('x-api-key');
    expect(src).not.toContain('anthropic_api_key');
    expect(src).not.toContain('anthropic-version');
  });

  it('accepts category parameter for cost attribution', () => {
    expect(src).toContain('category: str = "content_engine"');
  });

  it('reads INTERNAL_API_SECRET from env', () => {
    expect(src).toContain('INTERNAL_API_SECRET');
  });

  it('targets the TS backend explicitly instead of inferring from generic PORT', () => {
    expect(src).toContain('NEXUS_BACKEND_BASE_URL');
    expect(src).toContain('TS_BACKEND_BASE_URL');
    expect(src).toContain("NEXUS_BACKEND_PORT");
    expect(src).toContain("TS_BACKEND_PORT");
    expect(src).not.toContain('os.environ.get("PORT", "8200")');
  });

  it('keeps MODEL and FAST_MODEL constants for backward compat', () => {
    expect(src).toContain('MODEL =');
    expect(src).toContain('FAST_MODEL =');
  });

  it('sends shared secret in x-internal-secret header', () => {
    expect(src).toContain('x-internal-secret');
  });

  it('logs which provider was used', () => {
    expect(src).toContain('provider');
  });

  it('requests JSON mode from the backend proxy for JSON synthesis calls', () => {
    expect(src).toContain('json_mode: bool = False');
    expect(src).toContain('"jsonMode": json_mode');
    expect(src).toContain('category=category, json_mode=True');
  });
});

describe('Python feedback_loop.py — no more feedback.json', () => {
  const src = readPy(path.join('learning', 'feedback_loop.py'));

  it('does NOT have _load_history or _save_history functions', () => {
    expect(src).not.toContain('def _load_history');
    expect(src).not.toContain('def _save_history');
  });

  it('does NOT use FEEDBACK_FILE constant', () => {
    expect(src).not.toContain('FEEDBACK_FILE');
  });

  it('does NOT write JSON files', () => {
    expect(src).not.toContain('json.dump(');
  });

  it('still calls Claude for analysis', () => {
    expect(src).toContain('ask_claude_json');
  });

  it('passes category to ask_claude_json', () => {
    expect(src).toContain('category="content_engine_feedback"');
  });
});

describe('Python report_gen.py — no more feedback.json', () => {
  const src = readPy(path.join('learning', 'report_gen.py'));

  it('does NOT use FEEDBACK_FILE constant or load from JSON file', () => {
    expect(src).not.toContain('FEEDBACK_FILE');
    expect(src).not.toContain('_load_history');
    expect(src).not.toContain('json.load(f)');
  });

  it('fetches from TS backend instead', () => {
    expect(src).toContain('_fetch_performance_history');
    expect(src).toContain('/api/v1/internal/performance-summary');
    expect(src).toContain('NEXUS_BACKEND_BASE_URL');
    expect(src).toContain('TS_BACKEND_BASE_URL');
    expect(src).not.toContain('os.environ.get("PORT", "8200")');
  });

  it('passes category to ask_claude_json', () => {
    expect(src).toContain('category="content_engine_report"');
  });
});

describe('Python script_writer.py — JSON metadata parsing', () => {
  const src = readPy(path.join('creative', 'script_writer.py'));

  it('instructs Claude to output ---METADATA--- separator', () => {
    expect(src).toContain('---METADATA---');
  });

  it('parses JSON metadata block', () => {
    expect(src).toContain('json.loads(metadata_raw)');
  });

  it('has fallback to legacy line parsing', () => {
    expect(src).toContain('_fallback_parse');
    expect(src).toContain('def _fallback_parse');
  });

  it('passes category to ask_claude', () => {
    expect(src).toContain('category="content_engine_script"');
  });

  it('returns a degraded fallback script when AI generation fails', () => {
    expect(src).toContain('def _build_degraded_script_response');
    expect(src).toContain('AI generation was unavailable; returned a templated degraded script grounded in the available research.');
    expect(src).toContain('except Exception as exc');
    expect(src).toContain('return _build_degraded_script_response(');
  });

  it('grounds degraded fallback copy in the requested topic instead of hardcoded fitness recovery copy', () => {
    expect(src).toContain('def _normalize_fallback_topic');
    expect(src).toContain('What nobody tells you about {subject}');
    expect(src).not.toContain('The recovery protocol after hard intervals');
    expect(src).not.toContain('Most athletes finish hard intervals');
  });

  it('supports chat render mode cleanup for concise chat delivery', () => {
    expect(src).toContain('def _normalize_render_mode');
    expect(src).toContain('def _render_mode_guidance');
    expect(src).toContain('def _clean_chat_script');
    expect(src).toContain('def _is_usable_key_point');
    expect(src).toContain('if render_mode == "chat"');
    expect(src).toContain('RENDER MODE RULES:');
    expect(src).toContain('Do NOT use production tags such as [SFX:]');
    expect(src).toContain('SHOW ON SCREEN');
    expect(src).toContain('re.sub(r"\\[(?:SFX|EDIT|CUT TO|PLAY CLIP):[^\\]]+\\]"');
  });

  it('supports detailed versus bullet-point script output styles', () => {
    expect(src).toContain('def _normalize_script_style');
    expect(src).toContain('def _script_style_guidance');
    expect(src).toContain('OUTPUT STYLE RULES:');
    expect(src).toContain('Write the bullet-point filming outline now');
    expect(src).toContain('Voice DNA memory was applied to the degraded fallback.');
  });

  it('uses shallow quick research on quick mode cache misses instead of always deep searching', () => {
    expect(src).toContain('normalized_mode = (getattr(req, "mode", "standard") or "standard").strip().lower()');
    expect(src).toContain('if normalized_mode == "quick":');
    expect(src).toContain('research = await orchestrator.quick_search(req.topic, max_results=3)');
    expect(src).toContain('research = await orchestrator.deep_search(req.topic, max_results=5)');
  });

  it('injects first-party topic context into the generation prompt', () => {
    expect(src).toContain('def _topic_context_block(req: ScriptRequest) -> str:');
    expect(src).toContain('FIRST-PARTY TOPIC CONTEXT:');
    expect(src).toContain('Hook idea already chosen upstream');
  });
});

describe('Python requests.py — script render mode contract', () => {
  const src = readPy(path.join('..', 'models', 'requests.py'));

  it('ScriptRequest exposes render_mode with a structured default', () => {
    expect(src).toContain('render_mode: str = Field(default="structured")');
  });

  it('ScriptRequest exposes mode and topic_context for richer script generation', () => {
    expect(src).toContain('mode: str = Field(default="standard")');
    expect(src).toContain('script_style: str = Field(default="detailed")');
    expect(src).toContain('topic_context: dict | None = Field(default=None)');
  });
});

describe('Python orchestrator.py — evergreen query handling', () => {
  const src = readPy('orchestrator.py');

  it('has a separate evergreen query strategy instead of always using viral expansions', () => {
    expect(src).toContain('def _is_evergreen_query');
    expect(src).toContain('def _build_search_variations');
    expect(src).toContain('evidence based guide');
    expect(src).toContain('guia prático baseado em evidência');
    expect(src).toContain('recuperar');
    expect(src).toContain('repetições');
  });

  it('re-ranks sources to penalize evergreen trend-bait noise', () => {
    expect(src).toContain('def _query_specific_rank');
    expect(src).toContain('EVERGREEN_NOISE_SIGNALS');
    expect(src).toContain('EVERGREEN_RESEARCH_SIGNALS');
  });

  it('adds a dedicated quick_search path for cheap shallow research', () => {
    expect(src).toContain('async def quick_search(self, query: str, max_results: int = 3) -> DeepSearchResponse:');
    expect(src).toContain('Quick mode used shallow research without AI synthesis.');
  });

  it('uses creator profile config instead of hardcoded worldview blocks in synthesis prompts', () => {
    expect(src).toContain('from services.creator_profile import get_profile');
    expect(src).toContain('{get_profile(short=True)}');
    expect(src).not.toContain('Brazilian conservative/libertarian');
  });
});

describe('Python mock searchers — evergreen-friendly local results', () => {
  const webSrc = readPy(path.join('..', 'searchers', 'web.py'));
  const youtubeSrc = readPy(path.join('..', 'searchers', 'youtube.py'));
  const newsSrc = readPy(path.join('..', 'searchers', 'news.py'));

  it('web mock avoids hardcoded viral framing for evergreen topics', () => {
    expect(webSrc).toContain('EVERGREEN_MOCK_HINTS');
    expect(webSrc).toContain('evidence overview');
    expect(webSrc).toContain('Practical guide to');
    expect(webSrc).toContain('recuperar');
  });

  it('youtube mock uses coaching-style evergreen titles when appropriate', () => {
    expect(youtubeSrc).toContain('EVERGREEN_MOCK_HINTS');
    expect(youtubeSrc).toContain('Coach breakdown');
    expect(youtubeSrc).toContain('practical walkthrough');
  });

  it('news mock uses evidence/protocol framing for evergreen topics', () => {
    expect(newsSrc).toContain('EVERGREEN_MOCK_HINTS');
    expect(newsSrc).toContain('practical protocol');
    expect(newsSrc).toContain('evidence review');
  });
});

describe('Python brief_builder.py — degraded briefs stay safe', () => {
  const src = readPy('brief_builder.py');

  it('does not inject raw Source context lines into fallback briefs', () => {
    expect(src).not.toContain('Source context:');
    expect(src).toContain('key_points=[]');
  });
});

describe('Python main.py — shared env loading stays aligned with local dev', () => {
  const src = readEngineFile('main.py');

  it('loads the shared .env.agents file before falling back to the engine-local env', () => {
    expect(src).toContain('".env.agents"');
    expect(src).toContain('_shared_env_candidates');
    expect(src).toContain('for _env_path in _shared_env_candidates');
  });
});

describe('Python book_knowledge.py — no hallucination on empty search', () => {
  const src = readPy('book_knowledge.py');

  it('does NOT ask Claude to "Use your knowledge"', () => {
    expect(src).not.toContain('Use your knowledge');
  });

  it('returns partial BookDNA when search is empty', () => {
    expect(src).toContain('[LOW CONFIDENCE]');
    expect(src).toContain('return BookDNA(');
  });

  it('logs a warning when search returns empty', () => {
    expect(src).toContain('No web search results for');
  });

  it('passes category to ask_claude_json', () => {
    expect(src).toContain('category="content_engine_book"');
  });
});

describe('Python creator_profile.py — reads from canonical config', () => {
  const src = readPy('creator_profile.py');

  it('reads from prompts/creator-config.md', () => {
    expect(src).toContain('creator-config.md');
    expect(src).toContain('_CONFIG_PATH');
  });

  it('does NOT have hardcoded CREATOR_PROFILE block', () => {
    // The old file had 60+ lines of hardcoded profile text
    // The new file reads from the canonical config file
    expect(src).not.toContain('BRAND PILLARS (not niches');
    expect(src).not.toContain('Asmongold-style delivery');
  });

  it('has a fallback for when the config file is missing', () => {
    expect(src).toContain('_FALLBACK_PROFILE');
    expect(src).toContain('FileNotFoundError');
  });
});
