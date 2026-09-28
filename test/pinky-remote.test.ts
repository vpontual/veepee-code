import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { parsePinkyContext, mirrorPinkyFromMcp, pinkyCacheDir } from '../src/pinky-remote.js';
import { findPinkyRoot } from '../src/context.js';

const SAMPLE = '=== PINKY.md ===\n# index\n\n=== identity/rules.md ===\n- rule one\n\n=== identity/voice.md ===\nvoice';

function fakeClient(result: unknown, fail = false) {
  return { serverName: 'pinky', callTool: async () => { if (fail) throw new Error('no such tool'); return result; } } as never;
}

describe('Pinky from the MCP server when there is no local clone', () => {
  it('splits pinky_context into its files', () => {
    expect(parsePinkyContext(SAMPLE).map(f => f.rel)).toEqual(['PINKY.md', 'identity/rules.md', 'identity/voice.md']);
    expect(parsePinkyContext(SAMPLE)[1].content).toBe('- rule one');
  });

  it('never writes outside the cache folder', () => {
    const evil = '=== ../../.bashrc.md ===\nx\n=== /etc/x.md ===\ny\n=== PINKY.md ===\nok';
    expect(parsePinkyContext(evil).map(f => f.rel)).toEqual(['PINKY.md']);
  });

  it('mirrors the files, and the mirror becomes the Pinky root', async () => {
    const home = mkdtempSync(join(tmpdir(), 'vcode-pinky-'));
    const n = await mirrorPinkyFromMcp([fakeClient({ content: [{ type: 'text', text: SAMPLE }] })], pinkyCacheDir(home));
    expect(n).toBe(3);
    expect(readFileSync(join(pinkyCacheDir(home), 'identity/rules.md'), 'utf-8')).toBe('- rule one\n');
    expect(findPinkyRoot(home)).toBe(pinkyCacheDir(home));
  });

  it('prefers a real clone over the mirror', async () => {
    const home = mkdtempSync(join(tmpdir(), 'vcode-pinky-'));
    await mirrorPinkyFromMcp([fakeClient({ content: [{ type: 'text', text: SAMPLE }] })], pinkyCacheDir(home));
    mkdirSync(join(home, 'pinky'), { recursive: true });
    writeFileSync(join(home, 'pinky', 'PINKY.md'), '# real');
    expect(findPinkyRoot(home)).toBe(join(home, 'pinky'));
  });

  it('skips servers without pinky_context and keeps the old mirror when none answers', async () => {
    const home = mkdtempSync(join(tmpdir(), 'vcode-pinky-'));
    expect(await mirrorPinkyFromMcp([fakeClient(null, true)], pinkyCacheDir(home))).toBe(0);
    expect(existsSync(pinkyCacheDir(home))).toBe(false);
  });
});
