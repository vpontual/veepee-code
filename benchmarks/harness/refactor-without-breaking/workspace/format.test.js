import { describe, it, expect } from 'vitest';
import { summarize, verboseSummary, timestampRow } from './src/report.js';

describe('report output is unchanged by the refactor', () => {
  const runs = [{ name: 'build', ms: 3661000 }, { name: 'test', ms: 45000 }];

  it('summarizes compactly', () => {
    expect(summarize(runs)).toBe('build: 1h 1m 1s\ntest: 45s');
  });

  it('summarizes verbosely with milliseconds', () => {
    expect(verboseSummary([{ name: 'x', ms: 65250 }]))
      .toBe('x: 1 minutes, 5 seconds, 250 milliseconds');
  });

  it('pads for the timestamp row', () => {
    expect(timestampRow({ name: 'y', ms: 3661000 })).toBe('y\t01h 01m 01s');
  });
});
