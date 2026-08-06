import { describe, it, expect } from 'vitest';
import * as surcharge from './src/surcharge.js';
import { RATES } from './src/rates.js';

/**
 * Grading test, introduced only after the agent finishes.
 *
 * surchargeGb is one wrong identifier among 44 structurally identical
 * functions: it multiplies by RATES.ge. The spot checks below exist because
 * the cheapest way to "fix" this file is a broad search-and-replace, which
 * corrects GB and quietly damages its neighbours.
 */
const GB_RATE = 2.58;

describe('surchargeGb uses the GB rate', () => {
  it('charges 10kg', () => {
    expect(surcharge.surchargeGb(10)).toBe(2580);
  });

  it('charges a fractional weight', () => {
    expect(surcharge.surchargeGb(2.5)).toBe(645);
  });

  it('charges nothing for nothing', () => {
    expect(surcharge.surchargeGb(0)).toBe(0);
  });
});

describe('the rate table was not touched', () => {
  it('kept the GB rate', () => {
    expect(RATES.gb).toBe(GB_RATE);
  });

  it('kept the GE rate', () => {
    expect(RATES.ge).toBe(2.61);
  });

  it('kept every entry', () => {
    expect(Object.keys(RATES).length).toBe(220);
  });
});

describe('the neighbouring functions are unchanged', () => {
  it('AC still charges its own rate', () => {
    expect(surcharge.surchargeAc(10)).toBe(1030);
  });

  it('BB still charges its own rate', () => {
    expect(surcharge.surchargeBb(10)).toBe(1280);
  });

  it('DY still charges its own rate', () => {
    expect(surcharge.surchargeDy(10)).toBe(2030);
  });

  it('IJ still charges its own rate', () => {
    expect(surcharge.surchargeIj(10)).toBe(3180);
  });

  it('still exports every destination', () => {
    expect(Object.keys(surcharge).length).toBe(44);
  });
});
