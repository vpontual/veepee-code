import { describe, it, expect } from 'vitest';
import { Profiler } from '../src/profiler.js';

describe('Profiler', () => {
  it('is a no-op when disabled', () => {
    const p = new Profiler(false);
    p.mark('one');
    p.mark('two');
    expect(p.render()).toBe('');
  });

  it('records marks when enabled', async () => {
    const p = new Profiler(true);
    await new Promise((res) => setTimeout(res, 5));
    p.mark('first');
    await new Promise((res) => setTimeout(res, 5));
    p.mark('second');
    const out = p.render();
    expect(out).toContain('Startup profile');
    expect(out).toContain('first');
    expect(out).toContain('second');
    expect(out).toContain('total init');
  });

  it('renders nothing when no marks were recorded even when enabled', () => {
    const p = new Profiler(true);
    expect(p.render()).toBe('');
  });
});
