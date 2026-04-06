import { describe, it, expect } from 'vitest';
import { PermissionManager } from '../src/permissions.js';
import { resolve } from 'path';

describe('PermissionManager', () => {
  it('auto-allows safe tools without prompting', async () => {
    const pm = new PermissionManager();
    const safeTools = ['read_file', 'list_files', 'glob', 'grep', 'git', 'news'];

    for (const tool of safeTools) {
      const result = await pm.check(tool, {});
      expect(result).toBe('allow');
    }
  });

  it('allows in API mode (no prompt handler) for unknown tools', async () => {
    const pm = new PermissionManager();
    // No prompt handler set — should auto-allow
    const result = await pm.check('bash', { command: 'ls' });
    expect(result).toBe('allow');
  });

  it('prompts for non-safe tools when handler is set', async () => {
    const pm = new PermissionManager();
    let promptedTool = '';
    pm.setPromptHandler(async (toolName) => {
      promptedTool = toolName;
      return 'y';
    });

    const result = await pm.check('bash', { command: 'ls' });
    expect(result).toBe('allow');
    expect(promptedTool).toBe('bash');
  });

  it('detects dangerous rm -rf pattern', async () => {
    const pm = new PermissionManager();
    let promptReason = '';
    pm.setPromptHandler(async (_tool, _args, reason) => {
      promptReason = reason || '';
      return 'n';
    });

    const result = await pm.check('bash', { command: 'rm -rf /tmp/test' });
    expect(result).toBe('deny');
    expect(promptReason).toBe('destructive delete');
  });

  it('detects dangerous force push pattern', async () => {
    const pm = new PermissionManager();
    let promptReason = '';
    pm.setPromptHandler(async (_tool, _args, reason) => {
      promptReason = reason || '';
      return 'n';
    });

    const result = await pm.check('bash', { command: 'git push origin main --force' });
    expect(result).toBe('deny');
    expect(promptReason).toBe('force push');
  });

  it('detects dangerous git reset --hard', async () => {
    const pm = new PermissionManager();
    let promptReason = '';
    pm.setPromptHandler(async (_tool, _args, reason) => {
      promptReason = reason || '';
      return 'n';
    });

    const result = await pm.check('git', { args: 'reset --hard HEAD~1' });
    expect(result).toBe('deny');
    expect(promptReason).toBe('hard reset');
  });

  it('detects docker cleanup as dangerous', async () => {
    const pm = new PermissionManager();
    let promptReason = '';
    pm.setPromptHandler(async (_tool, _args, reason) => {
      promptReason = reason || '';
      return 'y';
    });

    await pm.check('bash', { command: 'docker system prune -a' });
    expect(promptReason).toBe('docker cleanup');
  });

  it('session allow persists for same tool', async () => {
    const pm = new PermissionManager();
    let promptCount = 0;
    pm.setPromptHandler(async () => {
      promptCount++;
      return 'y'; // session allow
    });

    await pm.check('bash', { command: 'echo hello' });
    expect(promptCount).toBe(1);

    // Second call should not prompt (session allowed)
    await pm.check('bash', { command: 'echo world' });
    expect(promptCount).toBe(1);
  });

  it('dangerous patterns always prompt even if session allowed', async () => {
    const pm = new PermissionManager();
    let promptCount = 0;
    pm.setPromptHandler(async () => {
      promptCount++;
      return 'y';
    });

    // First: normal bash (prompts, gets session allowed)
    await pm.check('bash', { command: 'echo hello' });
    expect(promptCount).toBe(1);

    // Second: dangerous bash (should still prompt despite session allow)
    await pm.check('bash', { command: 'rm -rf /tmp/test' });
    expect(promptCount).toBe(2);
  });

  it('deny returns deny', async () => {
    const pm = new PermissionManager();
    pm.setPromptHandler(async () => 'n');

    const result = await pm.check('write_file', { path: '/tmp/test.txt' });
    expect(result).toBe('deny');
  });

  it('always allow returns allow_always', async () => {
    const pm = new PermissionManager();
    pm.setPromptHandler(async () => 'a');

    const result = await pm.check('write_file', { path: '/tmp/test.txt' });
    expect(result).toBe('allow_always');
  });

  it('revoke removes always-allowed tool', async () => {
    const pm = new PermissionManager();
    pm.setPromptHandler(async () => 'a');

    await pm.check('write_file', { path: '/tmp/test.txt' });

    let promptCount = 0;
    pm.setPromptHandler(async () => {
      promptCount++;
      return 'n';
    });

    // Should be auto-allowed (always)
    await pm.check('write_file', { path: '/tmp/other.txt' });
    expect(promptCount).toBe(0);

    // Revoke
    const revoked = pm.revoke('write_file');
    expect(revoked).toBe(true);

    // Should prompt again
    await pm.check('write_file', { path: '/tmp/other.txt' });
    expect(promptCount).toBe(1);
  });

  it('resetSession clears session permissions', async () => {
    const pm = new PermissionManager();
    let promptCount = 0;
    pm.setPromptHandler(async () => {
      promptCount++;
      return 'y';
    });

    await pm.check('bash', { command: 'echo' });
    expect(promptCount).toBe(1);

    pm.resetSession();

    await pm.check('bash', { command: 'echo' });
    expect(promptCount).toBe(2); // prompted again after reset
  });

  it('listPermissions returns correct structure', () => {
    const pm = new PermissionManager();
    const perms = pm.listPermissions();

    expect(perms).toHaveProperty('alwaysAllowed');
    expect(perms).toHaveProperty('sessionAllowed');
    expect(perms).toHaveProperty('safeTools');
    expect(Array.isArray(perms.safeTools)).toBe(true);
    expect(perms.safeTools).toContain('read_file');
    expect(perms.safeTools).toContain('glob');
  });

  it('project-scoped allow matches relative file paths after normalization', async () => {
    const pm = new PermissionManager();
    let promptCount = 0;
    pm.setPromptHandler(async () => {
      promptCount++;
      return 'p';
    });

    // First call prompts and stores project-scoped allow for write_file
    const first = await pm.check('write_file', { path: 'src/demo.ts' });
    expect(first).toBe('allow');
    expect(promptCount).toBe(1);

    // Switch handler to deny; second call should still auto-allow from project scope
    pm.setPromptHandler(async () => {
      promptCount++;
      return 'n';
    });
    const second = await pm.check('write_file', { path: 'src/other.ts' });
    expect(second).toBe('allow');
    expect(promptCount).toBe(1);
  });

  it('project-scoped allow matches absolute file paths', async () => {
    const pm = new PermissionManager();
    const absPath = resolve(process.cwd(), 'src/demo-abs.ts');
    let promptCount = 0;
    pm.setPromptHandler(async () => {
      promptCount++;
      return 'p';
    });

    const first = await pm.check('edit_file', { path: absPath });
    expect(first).toBe('allow');
    expect(promptCount).toBe(1);

    pm.setPromptHandler(async () => {
      promptCount++;
      return 'n';
    });
    const second = await pm.check('edit_file', { path: absPath });
    expect(second).toBe('allow');
    expect(promptCount).toBe(1);
  });
});
