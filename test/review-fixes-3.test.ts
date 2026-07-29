import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { previewEdit } from '../src/diff.js';
import { IgnoreManager } from '../src/ignore.js';
import { expandCommand } from '../src/user-commands.js';
import { truncateOutput } from '../src/inline-bash.js';

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'vcode-rf3-')); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, ''); // eslint-disable-line no-control-regex
const lines = (n: number, tag = 'x') =>
  Array.from({ length: n }, (_, i) => `const ${tag}${i} = ${i}; // line ${i}`).join('\n');

describe('diff: large files do not blow up the heap', () => {
  it('falls back to a positional summary instead of allocating an LCS matrix', () => {
    const oldC = lines(4000);
    const newC = oldC.replace('const x10 =', 'const x10Renamed =');
    const started = Date.now();
    const out = strip(previewEdit(oldC, newC, 'big.ts'));
    // Previously ~610ms and ~123MB for 4k lines; 20k lines exhausted the heap.
    expect(Date.now() - started).toBeLessThan(500);
    expect(out).toContain('too large for a full diff');
    expect(out).toContain('big.ts');
  });

  it('still produces a real diff for normal-sized files', () => {
    const oldC = lines(200);
    const newC = oldC.replace('const x10 =', 'const x10Renamed =');
    const out = strip(previewEdit(oldC, newC, 'small.ts'));
    expect(out).toContain('-const x10 = 10;');
    expect(out).toContain('+const x10Renamed = 10;');
    expect(out).not.toContain('too large');
  });

  it('does not emit a hunk separator before the very first line', () => {
    const out = strip(previewEdit('a\nb\nc', 'A\nb\nc', 'f.ts'));
    const body = out.split('\n');
    // Header, header, then the change — no leading "@@ ... @@".
    expect(body[2]).not.toContain('@@');
    expect(out).toContain('-a');
    expect(out).toContain('+A');
  });

  it('still shows a separator between genuinely distant hunks', () => {
    const a = lines(60, 'y');
    const b = a.replace('const y1 = 1;', 'const y1 = 111;').replace('const y50 = 50;', 'const y50 = 550;');
    expect(strip(previewEdit(a, b, 'f.ts'))).toContain('@@');
  });
});

describe('ignore: patterns that used to match nothing', () => {
  function mgr(patterns: string): IgnoreManager {
    writeFileSync(join(tmp, '.veepeignore'), patterns);
    return new IgnoreManager(tmp);
  }

  it('blocks a directory written gitignore-style with a trailing slash', () => {
    const m = mgr('secrets/\n');
    mkdirSync(join(tmp, 'secrets'), { recursive: true });
    expect(m.isBlocked(join(tmp, 'secrets', 'prod.yaml'))).toBe(true);
    expect(m.isBlocked(join(tmp, 'secrets', 'deep', 'a.txt'))).toBe(true);
  });

  it('blocks the contents of a bare directory name', () => {
    const m = mgr('node_modules\n');
    expect(m.isBlocked(join(tmp, 'node_modules', 'pkg', 'index.js'))).toBe(true);
  });

  it('does not over-match a name that merely shares the prefix', () => {
    const m = mgr('secrets/\n');
    expect(m.isBlocked(join(tmp, 'secretsauce.ts'))).toBe(false);
    expect(m.isBlocked(join(tmp, 'src', 'app.ts'))).toBe(false);
  });

  it('follows symlinks so the default credential blocks cannot be sidestepped', () => {
    writeFileSync(join(tmp, '.env'), 'SECRET=1');
    mkdirSync(join(tmp, 'config'), { recursive: true });
    symlinkSync(join(tmp, '.env'), join(tmp, 'config', 'local.json'));
    const m = new IgnoreManager(tmp);
    // resolve() normalises `..` but does not follow links, so this used to
    // hand .env straight to the model.
    expect(m.isBlocked(join(tmp, 'config', 'local.json'))).toBe(true);
  });
});

describe('user command expansion', () => {
  const cmd = (template: string) => ({ template } as Parameters<typeof expandCommand>[0]);

  it('does not re-expand tokens contained in the user arguments', () => {
    expect(expandCommand(cmd('Commit: $ARGUMENTS'), 'fix $1 handling'))
      .toBe('Commit: fix $1 handling');
  });

  it('inserts $& and backtick sequences literally', () => {
    const out = expandCommand(cmd('msg: $ARGUMENTS'), 'has $& and $` inside');
    expect(out).toBe('msg: has $& and $` inside');
  });

  it('still substitutes positional arguments', () => {
    expect(expandCommand(cmd('A=$1 B=$2'), 'one two')).toBe('A=one B=two');
    expect(expandCommand(cmd('A=${1}'), 'one')).toBe('A=one');
  });

  it('leaves an unmatched positional empty', () => {
    expect(expandCommand(cmd('A=$1 B=$2'), 'only')).toBe('A=only B=');
  });
});

describe('inline shell output truncation', () => {
  it('keeps the truncation marker when both caps trigger', () => {
    // The byte marker used to be appended before the line cap, which then cut
    // it off — so truncated output looked complete.
    const huge = Array.from({ length: 5000 }, (_, i) => `line ${i} ${'p'.repeat(50)}`).join('\n');
    const out = truncateOutput(huge);
    expect(out).toContain('truncated at');
    expect(out.split('\n').length).toBeLessThanOrEqual(202);
  });

  it('marks a line-only truncation', () => {
    const many = Array.from({ length: 500 }, (_, i) => `l${i}`).join('\n');
    expect(truncateOutput(many)).toContain('200 lines');
  });

  it('leaves short output alone', () => {
    expect(truncateOutput('hello\nworld')).toBe('hello\nworld');
    expect(truncateOutput('')).toBe('');
  });
});

describe('extras refuses to clobber an unreadable settings file', () => {
  it('throws rather than replacing the whole config', async () => {
    const home = join(tmp, 'home');
    mkdirSync(join(home, '.veepee-code'), { recursive: true });
    const settings = join(home, '.veepee-code', 'settings.json');
    // Hand-edited file with a trailing comma — the realistic corruption.
    writeFileSync(settings, '{\n  "proxyUrl": "http://x:11434",\n  "apiToken": "secret",\n}\n');

    const prev = process.env.HOME;
    process.env.HOME = home;
    try {
      const { addExtra } = await import('../src/extras/manager.js');
      expect(() => addExtra('typescript')).toThrow(/not valid JSON/i);
      // The critical part: the original file is untouched.
      expect(readFileSync(settings, 'utf-8')).toContain('"apiToken": "secret"');
    } finally {
      if (prev === undefined) delete process.env.HOME; else process.env.HOME = prev;
    }
  });
});
