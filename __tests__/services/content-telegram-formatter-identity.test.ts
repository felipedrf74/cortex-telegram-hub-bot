import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { formatDeepSearch, formatHotNews } from '../../src/services/content-telegram-formatter';

describe('content Telegram formatter identity safety', () => {
  it('renders legacy creator-angle labels without exposing the old user name', () => {
    const html = formatDeepSearch({
      query: 'topic',
      duration_ms: 12,
      search_count: 1,
      briefs: [
        {
          title: 'Idea',
          format: 'Reel',
          hook: 'Hook',
          why_now: [
            'RESUMO: Breve contexto.',
            'ÂNGULO DO FELIPE: transformar em um ponto de vista útil.',
          ].join('\n\n'),
          key_points: [],
          title_options: [],
          sources: [],
          score: 0.8,
          time_sensitive: false,
        },
      ],
    });

    expect(html).toContain('SEU ÂNGULO');
    expect(html).toContain('transformar em um ponto de vista útil');
    expect(html).not.toContain('FELIPE');
    expect(html).not.toContain('Felipe');
  });

  it('escapes Telegram command snippets derived from generated titles and topics', () => {
    const deepSearchHtml = formatDeepSearch({
      query: 'topic',
      duration_ms: 12,
      search_count: 1,
      briefs: [
        {
          title: 'Use <script>alert(1)</script> & ship',
          format: 'Reel',
          hook: 'Hook',
          why_now: '',
          key_points: [],
          title_options: [],
          sources: [],
          score: 0.8,
          time_sensitive: false,
        },
      ],
    });
    const hotNewsHtml = formatHotNews({
      generated_at: '2026-04-24T00:00:00.000Z',
      topics: [
        {
          topic: 'Hot <b>angle</b> & exploit',
          heat_score: 0.8,
          sources: [],
          first_seen: null,
          niche: 'technology',
        },
      ],
    });

    expect(deepSearchHtml).toContain('/genscript Use &lt;script&gt;alert(1)&lt;/script&gt; &amp; ship');
    expect(hotNewsHtml).toContain('/deepsearch Hot &lt;b&gt;angle&lt;/b&gt; &amp; exploit');
    expect(deepSearchHtml).not.toContain('<code>/genscript Use <script>');
    expect(hotNewsHtml).not.toContain('<code>/deepsearch Hot <b>');
  });

  it('keeps the closed-beta identity scanner strict-clean', () => {
    const output = execFileSync('bash', ['scripts/closed-beta-identity-scan.sh', '--strict'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });

    expect(output).toContain('Total flags: 0');
  }, 30_000);
});
