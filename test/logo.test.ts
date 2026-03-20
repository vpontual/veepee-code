import { describe, it, expect } from 'vitest';
import { getLogo, getLogoWidth, getLogoHeight } from '../src/tui/logo.js';
import { stripAnsi } from '../src/tui/screen.js';

describe('getLogo', () => {
  it('returns full logo for wide terminals', () => {
    const logo = getLogo(120);
    expect(logo.length).toBe(getLogoHeight());
    // Should contain VEEPEE block characters
    expect(logo.some(line => stripAnsi(line).includes('██'))).toBe(true);
  });

  it('returns compact logo for narrow terminals', () => {
    const logo = getLogo(30);
    expect(logo.length).toBe(1);
    expect(stripAnsi(logo[0])).toContain('veepee code');
  });

  it('switches at the logo width boundary', () => {
    const logoWidth = getLogoWidth();

    // Just wide enough — should get full logo
    const wide = getLogo(logoWidth + 4);
    expect(wide.length).toBeGreaterThan(1);

    // Too narrow — should get compact
    const narrow = getLogo(logoWidth);
    expect(narrow.length).toBe(1);
  });
});

describe('getLogoWidth', () => {
  it('returns a positive number', () => {
    expect(getLogoWidth()).toBeGreaterThan(0);
  });
});

describe('getLogoHeight', () => {
  it('returns the number of logo lines', () => {
    expect(getLogoHeight()).toBeGreaterThan(0);
  });
});
