import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { collectHooks, HOOK_EVENTS } from '../src/hooks.js';

let home: string; let proj: string; const saved = process.env.HOME;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'hk-')); proj = mkdtempSync(join(tmpdir(), 'hkp-')); process.env.HOME = home; mkdirSync(join(home, '.veepee-code')); });
afterEach(() => { process.env.HOME = saved; rmSync(home, { recursive: true, force: true }); rmSync(proj, { recursive: true, force: true }); });

describe('hook events and formats', () => {
  it('knows the new events', () => {
    expect(HOOK_EVENTS).toEqual(expect.arrayContaining(['SessionStart', 'PreCompact', 'SubagentStop']));
  });

  it("accepts Claude Code's nested format (timeout in seconds) and vcode's flat one", () => {
    writeFileSync(join(home, '.veepee-code', 'settings.json'), JSON.stringify({ hooks: {
      SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: 'echo from-claude-format', timeout: 5 }, { type: 'prompt', command: 'ignored' }] }],
      PreToolUse: [{ matcher: 'bash', command: 'echo flat' }],
    } }));
    const start = collectHooks('SessionStart', proj);
    expect(start.map(h => h.hook)).toEqual([{ matcher: '', command: 'echo from-claude-format', timeoutMs: 5000 }]);
    expect(collectHooks('PreToolUse', proj).map(h => h.hook.command)).toEqual(['echo flat']);
  });
});
