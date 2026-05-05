import { describe, it, expect } from 'vitest';
import { runChecks } from '../src/doctor/runner.js';
import { renderDoctor } from '../src/doctor/render.js';
import type { Check } from '../src/doctor/types.js';

function check(id: string, severity: 'ok' | 'warn' | 'error' | 'info', message: string, fix?: () => Promise<{ ok: boolean; message: string }>): Check {
  return {
    id,
    category: 'Test',
    description: id,
    run: async () => ({ severity, message }),
    fix,
  };
}

describe('doctor.runChecks', () => {
  it('returns a tallied summary', async () => {
    const summary = await runChecks([
      check('a', 'ok', 'fine'),
      check('b', 'warn', 'meh'),
      check('c', 'error', 'broken'),
      check('d', 'info', 'fyi'),
      check('e', 'ok', 'fine'),
    ]);
    expect(summary.total).toBe(5);
    expect(summary.ok).toBe(2);
    expect(summary.warnings).toBe(1);
    expect(summary.errors).toBe(1);
    expect(summary.info).toBe(1);
  });

  it('catches exceptions in run() as errors', async () => {
    const summary = await runChecks([
      {
        id: 'throws',
        category: 'Test',
        description: 'will throw',
        run: async () => { throw new Error('boom'); },
      },
    ]);
    expect(summary.errors).toBe(1);
    expect(summary.results[0].result.severity).toBe('error');
    expect(summary.results[0].result.detail).toContain('boom');
  });

  it('times out a hung check at 10s without blocking the rest', async () => {
    const start = Date.now();
    const summary = await runChecks([
      {
        id: 'hung',
        category: 'Test',
        description: 'hangs forever',
        run: () => new Promise(() => {}), // never resolves
      },
      check('after', 'ok', 'fine'),
    ]);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(11_500);
    expect(summary.errors).toBe(1);
    expect(summary.results[0].result.message).toContain('timed out');
    expect(summary.ok).toBe(1);
  }, 15_000);
});

describe('doctor.renderDoctor', () => {
  it('groups by category and shows the summary footer', async () => {
    const summary = await runChecks([
      check('a', 'ok', 'fine'),
      check('b', 'error', 'broken'),
    ]);
    const out = renderDoctor(summary);
    expect(out).toContain('Test');
    expect(out).toContain('fine');
    expect(out).toContain('broken');
    expect(out).toContain('Summary:');
    expect(out).toContain('1 ok');
    expect(out).toContain('1 error');
  });

  it('mentions fixable issues when a check has a fix() method', async () => {
    const fixable = check('fixable', 'error', 'broken', async () => ({ ok: true, message: 'fixed' }));
    const summary = await runChecks([fixable]);
    const out = renderDoctor(summary);
    expect(out).toContain('can be fixed automatically');
    expect(out).toContain('/doctor fix');
  });

  it('does not advertise fix when there is nothing fixable', async () => {
    const summary = await runChecks([check('plain', 'error', 'broken')]);
    const out = renderDoctor(summary);
    expect(out).not.toContain('can be fixed automatically');
  });
});
