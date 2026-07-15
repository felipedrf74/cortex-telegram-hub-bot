import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const CANONICAL = {
  proUsd: '$14.99',
  proBrl: 'R$74.99',
  maxUsd: '$19.99',
  maxBrl: 'R$99.99',
};

function read(path: string): string {
  return fs.readFileSync(path, 'utf8');
}

describe('owner-confirmed subscription price display contract', () => {
  it('keeps env price comments aligned with the owner-confirmed Stripe amounts', () => {
    const env = read('.env.example');

    expect(env).toContain(`STRIPE_PRICE_PRO_MONTHLY=price_1TYUtmEnGIEp1Q5vqsfLN9Ml       # Pro ${CANONICAL.proUsd}/mo`);
    expect(env).toContain(`STRIPE_PRICE_PRO_MONTHLY_BRL=price_1TYUtnEnGIEp1Q5vMfu5XXt1   # Pro ${CANONICAL.proBrl}/mo`);
    expect(env).toContain(`STRIPE_PRICE_MAX_MONTHLY=price_1TYUtoEnGIEp1Q5vievUfmeu       # Max ${CANONICAL.maxUsd}/mo`);
    expect(env).toContain(`STRIPE_PRICE_MAX_MONTHLY_BRL=price_1TYUtpEnGIEp1Q5vtuAejLdn   # Max ${CANONICAL.maxBrl}/mo`);
  });

  it('keeps the portal landing price matrix and alt copy aligned', () => {
    const landing = read('src/portal/landing.html');

    expect(landing).toContain('USD monthly: Pro $14.99, Max $19.99');
    expect(landing).toContain('BRL monthly: Pro R$74.99, Max R$99.99');
    expect(landing).toContain("monthly: { pro: 14.99, max: 19.99");
    expect(landing).toContain("monthly: { pro: 74.99, max: 99.99");
    expect(landing).toContain('também em BRL por R$74,99/mês');
    expect(landing).toContain('também em BRL por R$99,99/mês');
    expect(landing).toContain('also available in BRL at R$74.99/mo');
    expect(landing).toContain('also available in BRL at R$99.99/mo');
  });

  it('keeps the canonical quota contract aligned', () => {
    expect(read('docs/TOKEN-QUOTA-CONTRACT.md')).toContain(
      `Pro at \`${CANONICAL.proUsd}\` and Max at \`${CANONICAL.maxUsd}\``,
    );
  });

  it('does not keep stale pre-confirmation plan prices in active pricing surfaces', () => {
    const activePricingSurfaces = [
      '.env.example',
      'src/portal/landing.html',
      'docs/TOKEN-QUOTA-CONTRACT.md',
    ];

    const staleAmounts = ['$24.99', 'R$69.99', 'R$69,99', 'R$119.99', 'R$119,99'];

    for (const surface of activePricingSurfaces) {
      const contents = read(surface);
      for (const staleAmount of staleAmounts) {
        expect(contents, `${surface} still contains stale amount ${staleAmount}`).not.toContain(staleAmount);
      }
    }
  });
});
