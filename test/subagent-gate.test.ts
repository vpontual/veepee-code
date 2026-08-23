import { describe, it, expect } from 'vitest';
import { PermissionManager, PLAN_REFUSED_TOOLS } from '../src/permissions.js';
import { readFileSync } from 'fs';

/**
 * Two holes that made the permission system decorative in the places it was
 * least observable.
 */
describe('unattended runs still refuse dangerous commands', () => {
  it('approves ordinary work and refuses the undoable', async () => {
    const pm = new PermissionManager();
    pm.setPromptHandler(PermissionManager.unattendedHandler());
    // Print mode, goal mode, --improve and the eval harness all installed
    // `async () => 'y'` — approve EVERYTHING — which made rm -rf, force push,
    // reset --hard, mkfs, dd of= and the git config guard decorative in exactly
    // the modes where nobody is watching.
    expect(await pm.check('bash', { command: 'ls -la' })).toBe('allow');
    expect(await pm.check('bash', { command: 'rm -rf /tmp/x' })).toBe('deny');
    expect(await pm.check('bash', { command: 'git push --force origin main' })).toBe('deny');
    expect(await pm.check('bash', { command: 'git branch --u' })).toBe('deny');
  });

  it('has one explicit, greppable opt-out', async () => {
    process.env.VCODE_UNATTENDED_ALLOW_DANGEROUS = '1';
    try {
      const pm = new PermissionManager();
      pm.setPromptHandler(PermissionManager.unattendedHandler());
      expect(await pm.check('bash', { command: 'rm -rf /tmp/x' })).toBe('allow');
    } finally {
      delete process.env.VCODE_UNATTENDED_ALLOW_DANGEROUS;
    }
  });
});

describe('subagents are not a way around the gate', () => {
  it('refuses `task` in plan mode', () => {
    // Spawning a subagent with tools:['bash'] reproduced everything plan mode
    // exists to prevent, out of sight of the user.
    expect(PLAN_REFUSED_TOOLS.has('task')).toBe(true);
  });

  it('checks permissions before executing a subagent tool call', () => {
    const src = readFileSync(new URL('../src/subagent.ts', import.meta.url), 'utf-8');
    const executes = src.match(/registry\.execute\(toolName, toolArgs\)/g) || [];
    const gates = src.match(/await this\.permissions\.check\(toolName, toolArgs\)/g) || [];
    // Every execution path — legacy SubAgent and GenericSubAgent — is gated.
    expect(gates.length).toBe(executes.length);
  });

  it('keeps one manager instance so /agents can see what task spawned', () => {
    const src = readFileSync(new URL('../src/agent.ts', import.meta.url), 'utf-8');
    const constructions = src.match(/new SubAgentManager\(/g) || [];
    // Was two: the constructor's, and a replacement inside loadRoster() — under
    // a comment promising the instance persists.
    expect(constructions.length).toBe(1);
    expect(src).toContain('this.subAgents.setRoster(this.roster)');
    expect(src).toContain('this.subAgents.setPermissions(permissions)');
  });
});
