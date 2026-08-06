import { describe, it, expect } from 'vitest';
import { nextPosture, PERMISSION_POSTURES, PermissionManager, EDIT_TOOLS, PLAN_REFUSED_TOOLS } from '../src/permissions.js';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

function isolated(): PermissionManager {
  const home = mkdtempSync(join(tmpdir(), 'vcode-posture-'));
  const prev = process.env.HOME;
  process.env.HOME = home;
  try { return new PermissionManager(); } finally { if (prev) process.env.HOME = prev; }
}

describe('the Shift+Tab ring', () => {
  it('cycles manual -> accept edits -> plan -> auto -> manual', () => {
    expect(PERMISSION_POSTURES).toEqual(['manual', 'accept_edits', 'plan', 'auto']);
    let p = PERMISSION_POSTURES[0];
    const seen = [p];
    for (let i = 0; i < 4; i++) { p = nextPosture(p); seen.push(p); }
    expect(seen).toEqual(['manual', 'accept_edits', 'plan', 'auto', 'manual']);
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

  it('plan refuses mutations WITH a reason the model can read', async () => {
    const perms = isolated();
    for (const t of PLAN_REFUSED_TOOLS) {
      const r = await perms.checkWithPosture('plan', t, { command: 'x', path: 'a.ts' });
      expect(typeof r).toBe('object');
      expect((r as { decision: string }).decision).toBe('deny');
      expect((r as { reason: string }).reason).toMatch(/plan mode/i);
      // The lesson from the drift incident: never silently substitute.
      expect((r as { reason: string }).reason).toMatch(/Do NOT reproduce by hand/);
    }
  });

  it('plan still allows reading', async () => {
    const perms = isolated();
    expect(await perms.checkWithPosture('plan', 'read_file', { path: 'a.ts' })).toBe('allow');
    expect(await perms.checkWithPosture('plan', 'grep', { pattern: 'x' })).toBe('allow');
  });

  it('manual defers to the normal check', async () => {
    const perms = isolated();
    let asked = false;
    perms.setPromptHandler(async () => { asked = true; return 'allow'; });
    await perms.checkWithPosture('manual', 'bash', { command: 'echo hi' });
    expect(asked).toBe(true);
  });
});
