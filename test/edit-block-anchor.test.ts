import { describe, it, expect } from 'vitest';
import { applySingleEdit, findBlockAnchorMatch, levenshtein } from '../src/tools/coding.js';

/**
 * The failure every other strategy misses: the model reproduces the SHAPE of a
 * block correctly and gets one middle line wrong — a paraphrased comment, a
 * renamed local, a dropped blank line. Exact, whitespace-normalized and
 * de-indented matching all require a faithful reproduction modulo whitespace,
 * so each of those costs a full round trip to discover.
 */
const FILE = [
  'function total(items) {',
  '  // sum every line item',
  '  let sum = 0;',
  '  for (const item of items) {',
  '    sum += item.price;',
  '  }',
  '  return sum;',
  '}',
  '',
].join('\n');

describe('levenshtein', () => {
  it('measures single-line edit distance', () => {
    expect(levenshtein('abc', 'abc')).toBe(0);
    expect(levenshtein('kitten', 'sitting')).toBe(3);
    expect(levenshtein('', 'abc')).toBe(3);
  });
});

describe('block-anchor edit recovery', () => {
  it('applies an edit whose middle line the model paraphrased', () => {
    const oldStr = [
      '  for (const item of items) {',
      '    sum += item.cost;',        // WRONG: the file says item.price
      '  }',
    ].join('\n');
    const r = applySingleEdit(FILE, oldStr, '  for (const i of items) sum += i.price;', false, 'total.js');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.updated).toContain('for (const i of items) sum += i.price;');
      expect(r.updated).not.toContain('for (const item of items) {');
      expect(r.matchCount).toBe(1);
    }
  });

  it('tolerates a block whose length differs from the needle', () => {
    const oldStr = [
      'function total(items) {',
      '  // sum every line item',
      '  let sum = 0;',
      '  for (const item of items) {',
      '    sum += item.price;',
      '  }',
      '',                            // an extra blank line the file does not have
      '  return sum;',
      '}',
    ].join('\n');
    const r = applySingleEdit(FILE, oldStr, 'function total(items) { return 0; }', false, 'total.js');
    expect(r.ok).toBe(true);
  });

  it('refuses when two candidate blocks are equally good', () => {
    // Editing the wrong block is far worse than one more round trip, so a tie
    // is refused rather than resolved by taking the max.
    const twice = FILE + '\n' + FILE;
    const oldStr = [
      '  for (const item of items) {',
      '    sum += item.cost;',
      '  }',
    ].join('\n');
    const r = applySingleEdit(twice, oldStr, 'x', false, 'total.js');
    expect(r.ok).toBe(false);
  });

  it('never fires for a needle with no middle, or with empty anchors', () => {
    expect(findBlockAnchorMatch(FILE, '  let sum = 0;')).toBeNull();
    expect(findBlockAnchorMatch(FILE, ['', '  let sum = 0;', ''].join('\n'))).toBeNull();
  });

  it('does not fire when the middle is unrecognisably different', () => {
    const oldStr = [
      '  for (const item of items) {',
      '    launchTheMissiles(item, {mode: "immediate", confirm: false});',
      '  }',
    ].join('\n');
    expect(findBlockAnchorMatch(FILE, oldStr)).toBeNull();
  });

  it('is not used for replace_all — an approximate match must not repeat', () => {
    const oldStr = [
      '  for (const item of items) {',
      '    sum += item.cost;',
      '  }',
    ].join('\n');
    const r = applySingleEdit(FILE, oldStr, 'x', true, 'total.js');
    expect(r.ok).toBe(false);
  });

  it('leaves exact matches alone (strategy order is preserved)', () => {
    const r = applySingleEdit(FILE, '  let sum = 0;', '  let sum = 0.0;', false, 'total.js');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.updated).toContain('let sum = 0.0;');
  });
});
