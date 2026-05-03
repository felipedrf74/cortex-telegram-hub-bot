import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { formatDeepSearch } from '../../src/services/content-telegram-formatter';

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

  it('keeps the closed-beta identity scanner strict-clean', () => {
    const output = execFileSync('bash', ['scripts/closed-beta-identity-scan.sh', '--strict'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });

    expect(output).toContain('Total flags: 0');
  }, 30_000);
});
