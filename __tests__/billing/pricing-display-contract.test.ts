import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const CANONICAL = {
  proUsd: '$9.99',
  maxUsd: '$14.99',
  proPriceId: 'price_1U55BS3kbWVFdS6025onefOr',
  maxPriceId: 'price_1U55Cl3kbWVFdS60VAeMzEyf',
};

function read(path: string): string {
  return fs.readFileSync(path, 'utf8');
}

describe('owner-confirmed subscription price display contract', () => {
  it('keeps env price comments aligned with the owner-confirmed Stripe amounts', () => {
    const env = read('.env.example');

    expect(env).toContain(`STRIPE_PRICE_PRO_MONTHLY=${CANONICAL.proPriceId}  # Pro ${CANONICAL.proUsd}/mo USD reference price`);
    expect(env).toContain(`STRIPE_PRICE_MAX_MONTHLY=${CANONICAL.maxPriceId}  # Max ${CANONICAL.maxUsd}/mo USD reference price`);
    expect(env).toContain('STRIPE_PRICE_ID_POINTS_SMALL=price_1U55D63kbWVFdS609PBBp7ek   # 100 credits · $4.99');
    expect(env).toContain('STRIPE_PRICE_ID_POINTS_MEDIUM=price_1U55DN3kbWVFdS60vjYzf3Ij  # 250 credits · $9.99');
    expect(env).toContain('STRIPE_PRICE_ID_POINTS_LARGE=price_1U55Dd3kbWVFdS601IUwkSe3   # 600 credits · $19.99');
  });

  it('keeps the portal landing price matrix and alt copy aligned', () => {
    const landing = read('src/portal/landing.html');

    expect(landing).toContain('USD monthly: Pro $9.99, Max $14.99');
    expect(landing).toContain("monthly: { pro: 9.99, max: 14.99");
    expect(landing).toContain('Local currency and final tax are shown at secure checkout.');
    expect(landing).not.toContain('data-currency="BRL"');
  });

  it('renders credit-pack prices with cents on user and operator surfaces', () => {
    expect(read('src/portal/user-login.html')).toContain("Number(pkg.priceUsd).toFixed(2)");
    expect(read('src/portal/portal.html')).toContain("Number(pkg.priceUsd || 0).toFixed(2)");
  });

  it('keeps the canonical quota contract aligned without rewriting release history', () => {
    expect(read('docs/TOKEN-QUOTA-CONTRACT.md')).toContain(
      `Pro at \`${CANONICAL.proUsd}\` and Max at \`${CANONICAL.maxUsd}\``,
    );
    expect(read('docs/TOKEN-QUOTA-CONTRACT.md')).toContain(
      '| Small | `me.nexushub.points.small` | $4.99 | 100 | $0.10 | 30 days |',
    );
  });

  it('does not keep stale pre-confirmation plan prices in active pricing surfaces', () => {
    const activePricingSurfaces = [
      '.env.example',
      'src/portal/landing.html',
      'docs/TOKEN-QUOTA-CONTRACT.md',
    ];

    const staleAmounts = ['$24.99', 'R$69.99', 'R$69,99', 'R$119.99', 'R$119,99', '$74.99', '$99.99'];

    for (const surface of activePricingSurfaces) {
      const contents = read(surface);
      for (const staleAmount of staleAmounts) {
        expect(contents, `${surface} still contains stale amount ${staleAmount}`).not.toContain(staleAmount);
      }
    }
  });
});
