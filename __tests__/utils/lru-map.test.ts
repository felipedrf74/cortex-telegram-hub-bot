// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, it, expect } from 'vitest';
import { LRUMap } from '../../src/utils/lru-map';

describe('LRUMap', () => {
  it('stores and retrieves values', () => {
    const lru = new LRUMap<string, number>(3);
    lru.set('a', 1);
    expect(lru.get('a')).toBe(1);
    expect(lru.has('a')).toBe(true);
    expect(lru.size).toBe(1);
  });

  it('evicts the least-recently-used entry when over capacity', () => {
    const lru = new LRUMap<string, number>(3);
    lru.set('a', 1);
    lru.set('b', 2);
    lru.set('c', 3);
    // All three present
    expect([...lru.keys()]).toEqual(['a', 'b', 'c']);
    // Insert a 4th — 'a' should be evicted as LRU
    lru.set('d', 4);
    expect(lru.has('a')).toBe(false);
    expect(lru.has('d')).toBe(true);
    expect(lru.size).toBe(3);
  });

  it('promotes recently-accessed keys to MRU position', () => {
    const lru = new LRUMap<string, number>(3);
    lru.set('a', 1);
    lru.set('b', 2);
    lru.set('c', 3);
    // Access 'a' — now it's the most-recently-used
    lru.get('a');
    // Insert a 4th — 'b' should be evicted now (it's the oldest)
    lru.set('d', 4);
    expect(lru.has('a')).toBe(true);
    expect(lru.has('b')).toBe(false);
    expect(lru.has('c')).toBe(true);
    expect(lru.has('d')).toBe(true);
  });

  it('updating an existing key moves it to MRU', () => {
    const lru = new LRUMap<string, number>(3);
    lru.set('a', 1);
    lru.set('b', 2);
    lru.set('c', 3);
    // Update 'a' — moves it to end of insertion order
    lru.set('a', 10);
    lru.set('d', 4);
    // 'b' should be evicted, 'a' should still be present with new value
    expect(lru.has('a')).toBe(true);
    expect(lru.get('a')).toBe(10);
    expect(lru.has('b')).toBe(false);
  });

  it('delete removes an entry', () => {
    const lru = new LRUMap<string, number>(3);
    lru.set('a', 1);
    expect(lru.delete('a')).toBe(true);
    expect(lru.has('a')).toBe(false);
    expect(lru.delete('nonexistent')).toBe(false);
  });

  it('clear empties the map', () => {
    const lru = new LRUMap<string, number>(3);
    lru.set('a', 1);
    lru.set('b', 2);
    lru.clear();
    expect(lru.size).toBe(0);
    expect(lru.has('a')).toBe(false);
  });

  it('rejects maxSize <= 0', () => {
    expect(() => new LRUMap<string, number>(0)).toThrow(/maxSize must be > 0/);
    expect(() => new LRUMap<string, number>(-1)).toThrow(/maxSize must be > 0/);
  });

  it('stress test: inserting 10× maxSize settles to exactly maxSize entries', () => {
    const lru = new LRUMap<number, number>(100);
    for (let i = 0; i < 1000; i++) {
      lru.set(i, i * 2);
    }
    expect(lru.size).toBe(100);
    // Last 100 keys should be present
    for (let i = 900; i < 1000; i++) {
      expect(lru.has(i)).toBe(true);
    }
    // First 900 keys should be evicted
    for (let i = 0; i < 900; i++) {
      expect(lru.has(i)).toBe(false);
    }
  });
});
