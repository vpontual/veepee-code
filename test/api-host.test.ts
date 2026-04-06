import { describe, it, expect } from 'vitest';
import { resolveApiHost } from '../src/api-host.js';

describe('resolveApiHost', () => {
  it('keeps configured host when RC is disabled', () => {
    expect(resolveApiHost(undefined, '127.0.0.1', false)).toBe('127.0.0.1');
    expect(resolveApiHost(undefined, '0.0.0.0', false)).toBe('0.0.0.0');
  });

  it('widens loopback host to 0.0.0.0 when RC is enabled', () => {
    expect(resolveApiHost(undefined, '127.0.0.1', true)).toBe('0.0.0.0');
    expect(resolveApiHost(undefined, 'localhost', true)).toBe('0.0.0.0');
    expect(resolveApiHost(undefined, '::1', true)).toBe('0.0.0.0');
  });

  it('does not widen non-loopback configured host when RC is enabled', () => {
    expect(resolveApiHost(undefined, '0.0.0.0', true)).toBe('0.0.0.0');
    expect(resolveApiHost(undefined, '192.168.1.10', true)).toBe('192.168.1.10');
  });

  it('honors explicit CLI host even when RC is enabled', () => {
    expect(resolveApiHost('127.0.0.1', '127.0.0.1', true)).toBe('127.0.0.1');
    expect(resolveApiHost('10.0.0.5', '127.0.0.1', true)).toBe('10.0.0.5');
  });
});

