import { describe, it, expect } from 'vitest';
import { surchargeAc, surchargeAh, surchargeAm, surchargeAr } from './surcharge.js';
import { rateFor } from './rates.js';

describe('surcharges', () => {
  it('charges AC', () => {
    expect(surchargeAc(10)).toBe(1030);
  });

  it('charges AH', () => {
    expect(surchargeAh(10)).toBe(1080);
  });

  it('charges AM', () => {
    expect(surchargeAm(10)).toBe(1130);
  });

  it('charges AR', () => {
    expect(surchargeAr(10)).toBe(1180);
  });

});

describe('rateFor', () => {
  it('falls back for an unknown destination', () => {
    expect(rateFor('zz')).toBe(1);
  });
});
