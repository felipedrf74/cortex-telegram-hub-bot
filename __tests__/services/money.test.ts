import { describe, expect, it } from 'vitest';
import { cents, centsToNumber, formatCents, parseUserAmount, toCents } from '../../src/services/money';

describe('money cent helpers', () => {
  it('represents decimal arithmetic exactly in cents', () => {
    expect(toCents(0.1) + toCents(0.2)).toBe(toCents(0.3));
    expect(centsToNumber(toCents(0.1) + toCents(0.2))).toBe(0.3);
  });

  it('parses Portuguese decimal and thousands separators', () => {
    expect(parseUserAmount('€1.234,56', 'EUR')).toBe(123456n);
    expect(parseUserAmount('12,34', 'EUR')).toBe(1234n);
  });

  it('rounds fractional cent strings without binary float conversion', () => {
    expect(parseUserAmount('1,005', 'EUR')).toBe(101n);
    expect(parseUserAmount('1,004', 'EUR')).toBe(100n);
    expect(toCents(1.005)).toBe(101n);
    expect(toCents(0.145)).toBe(15n);
  });

  it('normalizes scientific notation numbers before cent rounding', () => {
    expect(toCents(1e-7)).toBe(0n);
    expect(toCents(1.25e-2)).toBe(1n);
    expect(() => toCents(1e21)).toThrow(/too large/);
  });

  it('parses US decimal and thousands separators', () => {
    expect(parseUserAmount('$1,234.56', 'USD')).toBe(123456n);
  });

  it('allows negative amounts for refunds', () => {
    expect(parseUserAmount('-12,34', 'EUR')).toBe(-1234n);
    expect(cents(-12.34)).toBe(-1234n);
  });

  it('formats cents without going through binary float math', () => {
    const formatted = formatCents(123456n, 'pt-PT', 'EUR');
    expect(formatted).toContain('1234,56');
    expect(formatted).toContain('€');
  });

  it('parses large values at the safe Int64 cents boundary for iOS wire compatibility', () => {
    const maxInt64Cents = 9_223_372_036_854_775_807n;
    expect(parseUserAmount('92233720368547758,07', 'EUR')).toBe(maxInt64Cents);
  });
});
