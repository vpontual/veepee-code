import { describe, it, expect } from 'vitest';
import { nextPosture, PERMISSION_POSTURES, PermissionManager, EDIT_TOOLS, verifyAllows } from '../src/permissions.js';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

function isolated(): PermissionManager {
  const home = mkdtempSync(join(tmpdir(), 'vcode-posture-'));
  const prev = process.env.HOME;
  process.env.HOME = home;
  try { return new PermissionManager(); } finally { if (prev) process.env.HOME = prev; }
}

describe('postures', () => {
  it('are manual, accept edits and auto — the read-only hold is verify, not a posture', () => {
    expect(PERMISSION_POSTURES).toEqual(['manual', 'accept_edits', 'auto']);
    let p = PERMISSION_POSTURES[0];
    const seen = [p];
    for (let i = 0; i < 3; i++) { p = nextPosture(p); seen.push(p); }
    expect(seen).toEqual(['manual', 'accept_edits', 'auto', 'manual']);
  });
});

describe('posture behaviour', () => {
  it('auto allows an ordinary bash command without prompting', async () => {
    const perms = isolated();
    // No prompt handler installed: if this fell through to check() it would deny.
    expect(await perms.checkWithPosture('auto', 'bash', { command: 'npm test' })).toBe('allow');
  });

  it('auto STILL prompts for a dangerous pattern', async () => {
    const perms = isolated();
    let asked = false;
    perms.setPromptHandler(async () => { asked = true; return 'deny'; });
    await perms.checkWithPosture('auto', 'bash', { command: 'rm -rf /tmp/x' });
    expect(asked).toBe(true);
  });

  it('accept_edits allows edits but not bash', async () => {
    const perms = isolated();
    for (const t of EDIT_TOOLS) {
      expect(await perms.checkWithPosture('accept_edits', t, { path: 'a.ts' })).toBe('allow');
    }
    let asked = false;
    perms.setPromptHandler(async () => { asked = true; return 'deny'; });
    await perms.checkWithPosture('accept_edits', 'bash', { command: 'echo hi' });
    expect(asked).toBe(true);
  });

  // What must be HELD under verify: everything that is not read-only, including
  // tools nobody listed (MCP), git writes, and commands that would normally only prompt.
  const HELD: Array<[string, Record<string, unknown>]> = [
    ...[...EDIT_TOOLS].map(t => [t, { path: 'a.ts' }] as [string, Record<string, unknown>]),
    ['bash', { command: 'ls' }],
    ['bash', { command: 'rm -rf build' }],
    ['shell', { command: 'x' }],
    ['docker', { action: 'ps' }],
    ['task', { prompt: 'x' }],
    ['git', { args: 'commit -am x' }],
    ['git', { args: 'checkout -- .' }],
    ['github', { action: 'pr_merge' }],
    ['kill_shell', { id: '1' }],
    ['update_memory', { text: 'x' }],
    ['http_request', { url: 'http://x', method: 'POST' }],
    ['mcp__pinky__pinky_remember', { text: 'x' }],
  ];

  it('verify refuses everything not read-only WITH a reason, in every posture, before any prompt', async () => {
    const perms = isolated();
    let asked = false;
    perms.setPromptHandler(async () => { asked = true; return 'y'; });
    for (const posture of PERMISSION_POSTURES) {
      for (const [t, args] of HELD) {
        const r = await perms.checkWithPosture(posture, t, args, undefined, true);
        expect(typeof r, `${posture} ${t} ${JSON.stringify(args)}`).toBe('object');
        expect((r as { decision: string }).decision).toBe('deny');
        expect((r as { reason: string }).reason).toMatch(/request_approval/);
        // The lesson from the drift incident: never silently substitute.
        expect((r as { reason: string }).reason).toMatch(/Do NOT reproduce by hand/);
      }
    }
    expect(asked).toBe(false);
  });

  it('points a held shell command at the read-only tools', async () => {
    const r = await isolated().checkWithPosture('manual', 'bash', { command: 'git log -1' }, undefined, true);
    expect((r as { reason: string }).reason).toMatch(/use the git tool/);
  });

  it('verify lets read-only calls through', () => {
    for (const [t, args] of [
      ['read_file', {}], ['grep', {}], ['web_search', {}], ['lsp_references', {}],
      ['git', { args: 'status' }], ['git', { args: 'log --oneline' }],
      ['http_request', { url: 'http://x' }], ['request_approval', {}],
    ] as Array<[string, Record<string, unknown>]>) {
      expect(verifyAllows(t, args), t).toBe(true);
    }
  });

  it('verify holds subagents too: plain check() denies while it is on', async () => {
    const perms = isolated();
    perms.setPromptHandler(async () => 'y');
    perms.setVerify(true);
    expect(await perms.check('bash', { command: 'ls' })).toBe('deny');
    expect(await perms.check('read_file', { path: 'a' })).toBe('allow');
    perms.setVerify(false);
    expect(await perms.check('bash', { command: 'ls' })).toBe('allow');
  });

  it('verify still allows reading, and asking for approval', async () => {
    const perms = isolated();
    expect(await perms.checkWithPosture('manual', 'read_file', { path: 'a.ts' }, undefined, true)).toBe('allow');
    expect(await perms.checkWithPosture('manual', 'grep', { pattern: 'x' }, undefined, true)).toBe('allow');
    expect(await perms.checkWithPosture('manual', 'request_approval', { proposal: 'x' }, undefined, true)).toBe('allow');
  });

  it('verify off changes nothing', async () => {
    const perms = isolated();
    expect(await perms.checkWithPosture('auto', 'bash', { command: 'npm test' }, undefined, false)).toBe('allow');
  });

  it('approval always asks: an "always" answer is not remembered', async () => {
    const perms = isolated();
    let asked = 0;
    perms.setPromptHandler(async () => { asked++; return 'a'; });
    expect(await perms.approve('request_approval', 'the proposal')).toBe(true);
    expect(await perms.approve('request_approval', 'the proposal')).toBe(true);
    expect(asked).toBe(2);
    perms.setPromptHandler(async () => 'n');
    expect(await perms.approve('request_approval', 'the proposal')).toBe(false);
  });

  it('manual defers to the normal check', async () => {
    const perms = isolated();
    let asked = false;
    perms.setPromptHandler(async () => { asked = true; return 'allow'; });
    await perms.checkWithPosture('manual', 'bash', { command: 'echo hi' });
    expect(asked).toBe(true);
  });
});
