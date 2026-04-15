import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { debounce } from './solution.js';

describe('debounce', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('does not call synchronously', () => {
    const spy = vi.fn();
    const d = debounce(spy, 100);
    d('x');
    expect(spy).not.toHaveBeenCalled();
  });

  it('calls once after wait', () => {
    const spy = vi.fn();
    const d = debounce(spy, 100);
    d('a');
    vi.advanceTimersByTime(99);
    expect(spy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('a');
  });

  it('coalesces rapid calls and uses latest args', () => {
    const spy = vi.fn();
    const d = debounce(spy, 100);
    d('a'); vi.advanceTimersByTime(50);
    d('b'); vi.advanceTimersByTime(50);
    d('c'); vi.advanceTimersByTime(100);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('c');
  });

  it('fires again after idle period', () => {
    const spy = vi.fn();
    const d = debounce(spy, 100);
    d('a'); vi.advanceTimersByTime(100);
    d('b'); vi.advanceTimersByTime(100);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenNthCalledWith(1, 'a');
    expect(spy).toHaveBeenNthCalledWith(2, 'b');
  });
});
