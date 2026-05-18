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

  it('can forward scoped user and tenant metadata to the backend proxy', () => {
    expect(src).toContain('user_id: int | None = None');
    expect(src).toContain('tenant_id: int | None = None');
    expect(src).toContain('body["userId"] = user_id');
    expect(src).toContain('body["tenantId"] = tenant_id');
  });

  it('blocks AI proxy calls in local fixture mode', () => {
    expect(src).toContain('_FIXTURE_MODE');
    expect(src).toContain('CONTENT_ENGINE_FIXTURE_MODE');
    expect(src).toContain('NEXUS_LOCAL_ALLOW_MODEL_CALLS');
    expect(src).toContain('AI proxy disabled by Content Engine fixture mode.');
  });

  it('does not log raw model text when JSON repair fails', () => {
    expect(src).toContain('AI proxy returned non-JSON after repair attempt for category=%s (%d chars)');
    expect(src).not.toContain('raw[:200]');
  });

  it('does not log or rethrow raw AI proxy HTTP response bodies', () => {
    expect(src).toContain('AI proxy HTTP error %d for category=%s (%d chars)');
    expect(src).toContain('AI proxy error {e.response.status_code} for category={category}');
    expect(src).not.toContain('e.response.text[:300]');
    expect(src).not.toContain('e.response.text[:200]');
  });

  it('repairs fenced or malformed JSON instead of immediately degrading research synthesis', () => {
    expect(src).toContain('def _extract_json_candidate');
    expect(src).toContain('def _repair_json_response');
    expect(src).toContain("_json_repair");
    expect(src).toContain('AI JSON response repaired');
  });
});

describe('Python content-engine sensitive log sinks', () => {
  it('does not log raw gap finder model output after malformed JSON', () => {
    const src = readPy('intelligence/gap_finder.py');
    expect(src).toContain('Claude returned non-JSON in gap_finder (%d chars)');
    expect(src).not.toContain('raw: %s');
    expect(src).not.toContain('gaps.get("raw", ""))[:200]');
  });
});

describe('Python config.py — local fixture resource controls', () => {
  const src = readEngineFile('config.py');

  it('blanks external search/provider keys in explicit fixture mode', () => {
    expect(src).toContain('def _fixture_mode_enabled()');
    expect(src).toContain('CONTENT_ENGINE_FIXTURE_MODE');
    expect(src).toContain('NEXUS_LOCAL_ALLOW_MODEL_CALLS');
    expect(src).toContain('fixture_mode: bool = False');
    expect(src).toContain('fixture_mode=True');
    expect(src).toContain('internal_api_secret=internal_api_secret');
  });

  it('requires INTERNAL_API_SECRET before production startup', () => {
    expect(src).toContain('internal_api_secret: str = ""');
    expect(src).toContain('INTERNAL_API_SECRET');
    expect(src).toContain('ENV');
    expect(src).toContain('INTERNAL_API_SECRET must be set before starting the content engine in production.');
  });
});

describe('Python main.py — inbound internal auth', () => {
  const src = readEngineFile('main.py');

  it('protects all non-health routes with x-internal-secret', () => {
    expect(src).toContain('class InternalSecretMiddleware');
    expect(src).toContain('request.url.path == "/health"');
    expect(src).toContain('x-internal-secret');
    expect(src).toContain('secrets.compare_digest');
    expect(src).toContain('"UNAUTHORIZED"');
  });
});

describe('TypeScript content-engine callers — outbound internal auth', () => {
  it('forwards INTERNAL_API_SECRET from the shared content-engine client', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'services', 'content-engine.ts'), 'utf-8');
    expect(src).toContain('X-Internal-Secret');
    expect(src).toContain('config.contentEngine.internalApiSecret');
  });

  it('forwards INTERNAL_API_SECRET from book extraction calls', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'commands', 'books.ts'), 'utf-8');
    expect(src).toContain('X-Internal-Secret');
    expect(src).toContain('config.contentEngine.internalApiSecret');
  });
});

describe('Python reddit.py — fixture mode avoids live unauthenticated calls', () => {
  const src = readEngineFile(path.join('searchers', 'reddit.py'));

  it('returns deterministic mock results when fixture mode is enabled', () => {
    expect(src).toContain('if cfg.fixture_mode:');
    expect(src).toContain('Content-engine fixture mode');
    expect(src).toContain('def _mock');
    expect(src).toContain('Fixture mode avoids live Reddit calls.');
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
    expect(src).toContain('AI generation was unavailable; returned a topic-aware degraded draft grounded in available research.');
    expect(src).toContain('except Exception as exc');
    expect(src).toContain('return _build_degraded_script_response(');
  });

  it('grounds degraded fallback copy in the requested topic instead of hardcoded creator templates', () => {
    expect(src).toContain('def _normalize_fallback_topic');
    expect(src).toContain('def _fallback_hook');
    expect(src).toContain('def _fallback_default_beats');
    expect(src).toContain('hashlib.sha1');
    expect(src).toContain('topic-aware degraded draft');
    expect(src).not.toContain('The recovery protocol after hard intervals');
    expect(src).not.toContain('Most athletes finish hard intervals');
    expect(src).not.toContain('theoperator');
    expect(src).not.toContain('buildinpublic');
    expect(src).not.toContain('speed replaces judgment');
    expect(src).not.toContain('velocidade substitui critério');
  });

  it('builds the script system prompt per request without a global single-tenant persona', () => {
    expect(src).toContain('def _build_system_prompt(req: ScriptRequest) -> str:');
    expect(src).toContain('CREATOR CONTEXT FOR THIS REQUEST:');
    expect(src).toContain('Never assume a founder persona');
    expect(src).toContain('temperature=SCRIPT_TEMPERATURE');
    expect(src).not.toContain('SYSTEM_PROMPT =');
    expect(src).not.toContain('from services.creator_profile import get_profile');
    expect(src).not.toContain('as if Felipe is talking to camera');
    expect(src).not.toContain("The Operator's personality shines");
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
    expect(src).toContain('def _script_quality_guidance');
    expect(src).toContain('def _strip_inline_markdown_emphasis');
    expect(src).toContain('def _clean_script_dividers');
    expect(src).toContain('OUTPUT STYLE RULES:');
    expect(src).toContain('SCRIPT QUALITY BAR:');
    expect(src).toContain('Do not reuse the same hook/title/script skeleton');
    expect(src).toContain('Do NOT use decorative dividers or labels');
    expect(src).toContain('Choose the order of bullets from the topic itself');
    expect(src).toContain('Voice DNA memory was available, but the AI writer was unavailable');
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
    expect(src).toContain('creator_profile: str | None = Field(default=None)');
    expect(src).toContain('force_refresh: bool = Field(default=False)');
    expect(src).toContain('regeneration_seed: str | None = Field(default=None)');
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
    expect(src).toContain('from services.creator_context import creator_profile_block, language_instruction');
    expect(src).toContain('{creator_profile_block(creator_context)}');
    expect(src).toContain('{language_instruction(creator_context)}');
    expect(src).not.toContain('from services.creator_profile import get_profile');
    expect(src).not.toContain('{get_profile(short=True)}');
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

  it('uses neutral creator wording instead of gendered/founder-shaped copy', () => {
    expect(src).toContain('how would this creator use these ideas');
    expect(src).not.toContain('how would HE use');
    expect(src).not.toContain('align with his worldview');
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
