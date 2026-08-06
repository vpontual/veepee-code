import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as api from './src/index.js';
import { dispatch } from './src/dispatch.js';
import { chargeTotal } from './src/checkout.js';

/**
 * Grading test, introduced only after the agent finishes.
 *
 * The interesting reference is the string in handlers.json. A rename driven by
 * following imports renames four JS files, leaves the JSON alone, and breaks
 * only when the 'fee' event is dispatched — which the visible test never does.
 */
const files = ['src/fees.js', 'src/checkout.js', 'src/index.js', 'src/dispatch.js', 'handlers.json'];
const sources = Object.fromEntries(
  files.map((f) => [f, readFileSync(new URL(`./${f}`, import.meta.url), 'utf8')]),
);

describe('the new name is in place', () => {
  it('is exported from the barrel', () => {
    expect(typeof (api as Record<string, unknown>).calculateFee).toBe('function');
  });

  it('computes the same fee as before', () => {
    const calculateFee = (api as unknown as { calculateFee: (n: number) => number }).calculateFee;
    expect(calculateFee(10000)).toBe(320);
    expect(calculateFee(0)).toBe(30);
    expect(calculateFee(4999)).toBe(175);
  });
});

describe('the old name is gone', () => {
  it('is not exported', () => {
    expect((api as Record<string, unknown>).calcFee).toBeUndefined();
  });

  it('does not appear in any source file', () => {
    for (const [name, text] of Object.entries(sources)) {
      expect(text.includes('calcFee'), `${name} still mentions calcFee`).toBe(false);
    }
  });
});

describe('behaviour is unchanged', () => {
  it('still charges the total', () => {
    expect(chargeTotal(10000)).toBe(10320);
  });

  it('still dispatches the total event', () => {
    expect(dispatch('total', 10000)).toBe(10320);
  });

  it('still dispatches the fee event', () => {
    expect(dispatch('fee', 10000)).toBe(320);
  });

  it('still rejects an unknown event', () => {
    expect(() => dispatch('nope')).toThrow(/no handler/);
  });
});
