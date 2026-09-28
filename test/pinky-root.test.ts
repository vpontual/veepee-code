import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { findPinkyRoot } from '../src/context.js';

let home: string;
const brain = (dir: string, marked = false) => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'PINKY.md'), '# Pinky'); if (marked) writeFileSync(join(dir, '.this-host'), 'x'); };
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'pk-')); delete process.env.PINKY_ROOT; });
afterEach(() => { rmSync(home, { recursive: true, force: true }); delete process.env.PINKY_ROOT; });

describe('findPinkyRoot', () => {
  it('finds ~/pinky (archman) as well as ~/Nextcloud/pinky (laptop)', () => {
    brain(join(home, 'pinky'));
    expect(findPinkyRoot(home)).toBe(join(home, 'pinky'));
    rmSync(join(home, 'pinky'), { recursive: true });
    brain(join(home, 'Nextcloud', 'pinky'));
    expect(findPinkyRoot(home)).toBe(join(home, 'Nextcloud', 'pinky'));
  });
  it('prefers the clone marked .this-host, and $PINKY_ROOT over both', () => {
    brain(join(home, 'pinky'));
    brain(join(home, 'Nextcloud', 'pinky'), true);
    expect(findPinkyRoot(home)).toBe(join(home, 'Nextcloud', 'pinky'));
    const custom = join(home, 'elsewhere'); brain(custom);
    process.env.PINKY_ROOT = custom;
    expect(findPinkyRoot(home)).toBe(custom);
  });
  it('returns null when there is no brain', () => {
    expect(findPinkyRoot(home)).toBeNull();
  });
});
