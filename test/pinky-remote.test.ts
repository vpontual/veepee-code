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

import { pinkyShortRules } from '../src/context.js';

describe('short rules for subagents', () => {
  function homeWithRules(rules: string): string {
    const home = mkdtempSync(join(tmpdir(), 'vcode-rules-'));
    mkdirSync(join(home, 'pinky', 'identity'), { recursive: true });
    writeFileSync(join(home, 'pinky', 'PINKY.md'), '# index');
    writeFileSync(join(home, 'pinky', 'identity', 'rules.md'), rules);
    return home;
  }

  it('keeps each rule\'s lead and first sentence, under its heading, with a pointer to the full file', () => {
    const home = homeWithRules([
      '# Hard rules', '', '## Working with VP', '',
      '- **VP is the only developer.** Never attribute commits to',
      '  agents or imaginary collaborators. Longer explanation follows here.',
      '- **Test before presenting.** Verify it yourself.',
      '', '## Empty section', 'prose only', '',
    ].join('\n'));
    const r = pinkyShortRules(home);
    expect(r).toContain('Working with VP:');
    expect(r).toContain('- VP is the only developer. Never attribute commits to agents or imaginary collaborators.');
    expect(r).not.toContain('Longer explanation');
    expect(r).not.toContain('Empty section');
    expect(r).toContain(join(home, 'pinky', 'identity', 'rules.md'));
  });

  it('is empty without Pinky, so subagent prompts stay as they were', () => {
    expect(pinkyShortRules(mkdtempSync(join(tmpdir(), 'vcode-none-')))).toBe('');
  });

  it('is added to both kinds of subagent prompt', () => {
    const src = readFileSync(new URL('../src/subagent.ts', import.meta.url), 'utf-8');
    expect(src).toMatch(/return this\.rolePrompt\(\) \+ \(rules \?/);
    expect(src).toMatch(/\(this\.instructions \? `\\n\\n\$\{this\.instructions\}` : ''\) \+\s*withRules\(\)/);
  });
});
