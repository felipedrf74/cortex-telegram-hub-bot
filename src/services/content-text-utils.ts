// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

export interface ContentTokenOverlapOptions {
  minTokenLength?: number;
  emptyScore?: number;
  containmentScore?: number;
  floor?: number;
  cap?: number;
  denominator?: 'right' | 'union';
}

export interface ContentTokenJaccardOptions {
  minTokenLength?: number;
  stopwords?: ReadonlySet<string>;
}

export interface ContentBigramDiceOptions {
  includeShortGram?: boolean;
}

export function foldContentText(value: string): string {
  return value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim();
}

export function normalizeContentTopicText(value: string): string {
  return foldContentText(value).replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

export function contentTextTokens(value: string, minTokenLength = 3): string[] {
  return foldContentText(value).split(/\s+/).filter((token) => token.length >= minTokenLength);
}

export function contentTokenOverlap(
  left: string,
  right: string,
  options: ContentTokenOverlapOptions = {},
): number {
  const {
    minTokenLength = 3,
    emptyScore = 0,
    containmentScore = 1,
    floor = 0,
    cap = 1,
    denominator = 'right',
  } = options;
  const normalizedLeft = foldContentText(left);
  const normalizedRight = foldContentText(right);
  if (!normalizedLeft || !normalizedRight) return emptyScore;
  if (normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft)) {
    return containmentScore;
  }

  const leftTokens = new Set(contentTextTokens(normalizedLeft, minTokenLength));
  const rightTokens = contentTextTokens(normalizedRight, minTokenLength);
  if (leftTokens.size === 0 || rightTokens.length === 0) return emptyScore;

  const matches = rightTokens.filter((token) => leftTokens.has(token)).length;
  const divisor = denominator === 'union'
    ? new Set([...leftTokens, ...rightTokens]).size
    : rightTokens.length;
  if (divisor === 0) return emptyScore;

  const rawScore = matches / divisor;
  return Math.max(floor, Math.min(cap, rawScore));
}

export function contentTokenJaccard(
  left: string,
  right: string,
  options: ContentTokenJaccardOptions = {},
): number {
  const { minTokenLength = 3, stopwords } = options;
  const leftTokens = contentTokenSet(left, minTokenLength, stopwords);
  const rightTokens = contentTokenSet(right, minTokenLength, stopwords);
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return union === 0 ? 0 : intersection / union;
}

export function contentBigramDice(
  left: string,
  right: string,
  options: ContentBigramDiceOptions = {},
): number {
  const leftBigrams = contentBigrams(left, options.includeShortGram ?? false);
  const rightBigrams = contentBigrams(right, options.includeShortGram ?? false);
  if (leftBigrams.length === 0 || rightBigrams.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const item of leftBigrams) counts.set(item, (counts.get(item) ?? 0) + 1);

  let overlap = 0;
  for (const item of rightBigrams) {
    const count = counts.get(item) ?? 0;
    if (count <= 0) continue;
    counts.set(item, count - 1);
    overlap += 1;
  }

  return (2 * overlap) / (leftBigrams.length + rightBigrams.length);
}

function contentTokenSet(
  value: string,
  minTokenLength: number,
  stopwords: ReadonlySet<string> | undefined,
): Set<string> {
  return new Set(
    contentTextTokens(value, minTokenLength)
      .filter((token) => !stopwords?.has(token)),
  );
}

function contentBigrams(value: string, includeShortGram: boolean): string[] {
  const compact = value.replace(/\s+/g, ' ');
  if (compact.length < 2) return includeShortGram && compact ? [compact] : [];
  const grams: string[] = [];
  for (let i = 0; i < compact.length - 1; i += 1) grams.push(compact.slice(i, i + 2));
  return grams;
}
