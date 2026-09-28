import { describe, it, expect } from 'vitest';
import { isolateArgs } from '../src/subagent.js';

const main = '/repo';
const wt = '/repo/.veepee-worktrees/veepee-fix-abc';

describe('isolateArgs', () => {
  it('resolves relative paths inside the worktree', () => {
    expect(isolateArgs('read_file', { path: 'src/a.ts' }, wt, main)).toEqual({ path: `${wt}/src/a.ts` });
  });
  it('maps absolute paths into the main tree onto the worktree', () => {
    expect(isolateArgs('edit_file', { path: '/repo/src/a.ts', old_string: 'x' }, wt, main)).toEqual({ path: `${wt}/src/a.ts`, old_string: 'x' });
  });
  it('leaves paths already in the worktree, and paths outside the repo, alone', () => {
    expect(isolateArgs('read_file', { path: `${wt}/src/a.ts` }, wt, main).path).toBe(`${wt}/src/a.ts`);
    expect(isolateArgs('read_file', { path: '/etc/hosts' }, wt, main).path).toBe('/etc/hosts');
  });
  it('defaults bash cwd and search roots to the worktree', () => {
    expect(isolateArgs('bash', { command: 'npm test' }, wt, main)).toEqual({ command: 'npm test', cwd: wt });
    expect(isolateArgs('grep', { pattern: 'TODO' }, wt, main)).toEqual({ pattern: 'TODO', path: wt });
    expect(isolateArgs('glob', { pattern: '**/*.ts' }, wt, main).path).toBe(wt);
  });
});
