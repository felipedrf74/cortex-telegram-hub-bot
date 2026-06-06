// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

export type Cents = bigint;

const MONEY_SYMBOLS = /[€$£¥R$\s\u00a0]/g;

export function toCents(value: number): Cents {
  if (!Number.isFinite(value)) {
    throw new Error('Money amount must be finite');
  }
  return BigInt(Math.round(value * 100));
}

export function cents(value: number | string | bigint): Cents {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return toCents(value);
  return parseUserAmount(value);
}

export function centsToNumber(value: Cents | number | null | undefined): number {
  if (value == null) return 0;
  const asBigInt = typeof value === 'bigint' ? value : BigInt(Math.trunc(value));
  return Number(asBigInt) / 100;
}

export function formatCents(value: Cents | number, locale = 'pt-PT', currency = 'EUR'): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: currency.toUpperCase(),
  }).format(centsToNumber(value));
}

export function parseUserAmount(input: string | number, currency = 'EUR'): Cents {
  if (typeof input === 'number') return toCents(input);

  const normalizedCurrency = currency.trim().toUpperCase();
  let raw = input
    .trim()
    .replace(new RegExp(normalizedCurrency, 'gi'), '')
    .replace(MONEY_SYMBOLS, '');

  if (!raw) {
    throw new Error('Money amount is empty');
  }

  const negative = raw.startsWith('-');
  raw = raw.replace(/^[+-]/, '').replace(/[']/g, '');
  const commaIndex = raw.lastIndexOf(',');
  const dotIndex = raw.lastIndexOf('.');

  if (commaIndex >= 0 && dotIndex >= 0) {
    raw = commaIndex > dotIndex
      ? raw.replace(/\./g, '').replace(',', '.')
      : raw.replace(/,/g, '');
  } else if (commaIndex >= 0) {
    raw = raw.replace(',', '.');
  }

  if (!/^\d+(\.\d{1,})?$/.test(raw)) {
    throw new Error(`Invalid money amount: ${input}`);
  }

  const parsed = parseNormalizedDecimalToCents(raw);
  return negative ? -parsed : parsed;
}

function parseNormalizedDecimalToCents(raw: string): Cents {
  const [wholePart, fractionalPart = ''] = raw.split('.');
  const wholeCents = BigInt(wholePart) * 100n;
  const centsDigits = fractionalPart.padEnd(3, '0').slice(0, 3);
  const baseCents = BigInt(centsDigits.slice(0, 2));
  const shouldRoundUp = Number(centsDigits[2] ?? '0') >= 5;
  return wholeCents + baseCents + (shouldRoundUp ? 1n : 0n);
}
