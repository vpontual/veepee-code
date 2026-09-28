import { describe, it, expect } from 'vitest';
import { startBackground, buildBashOutputTool, buildKillShellTool } from '../src/tools/background.js';

const output = buildBashOutputTool();
const kill = buildKillShellTool();
const idOf = (text: string) => /Started (bg\d+)/.exec(text)![1];
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('background shell commands', () => {
  it('returns immediately, then reads only new output, then reports the exit', async () => {
    const t = Date.now();
    const id = idOf(startBackground('echo one; sleep 0.4; echo two').output);
    expect(Date.now() - t).toBeLessThan(200);
    await wait(150);
    const first = await output.execute({ id });
    expect(first.output).toContain('running');
    expect(first.output).toContain('one');
    expect(first.output).not.toContain('two');
    await wait(600);
    const second = await output.execute({ id });
    expect(second.output).toContain('exited with code 0');
    expect(second.output).toContain('two');
    expect(second.output).not.toContain('one');
    expect((await output.execute({ id })).output).toContain('(no new output)');
  });

  it('kill_shell stops the command and everything it started', async () => {
    const id = idOf(startBackground('sleep 30 & sleep 30; wait').output);
    await wait(150);
    const r = await kill.execute({ id });
    expect(r.output).toMatch(/stopped \((killed by SIG|exited)/);
    expect((await output.execute({ id })).output).not.toContain('running');
  });

  it('handles a trailing & and still stops what it started', async () => {
    const id = idOf(startBackground('sleep 30 &').output);
    await wait(200);
    expect((await output.execute({ id })).output).toContain('running');
    const r = await kill.execute({ id });
    expect(r.output).toContain('stopped');
  });

  it('kills children a finished command left behind', async () => {
    const id = idOf(startBackground('(sleep 30 &) ; echo launched').output);
    await wait(300);
    expect((await output.execute({ id })).output).toMatch(/still running|running/);
    expect((await kill.execute({ id })).output).toContain('stopped');
  });

  it('filters lines and lists commands', async () => {
    const id = idOf(startBackground('printf "GET /a 200\\nGET /b 500\\nGET /c 200\\n"').output);
    await wait(200);
    expect((await output.execute({ id, filter: ' 500' })).output).toContain('GET /b 500');
    expect((await output.execute({})).output).toContain(id);
    expect((await output.execute({ id: 'bg999' })).success).toBe(false);
  });
});

import { registerCodingTools } from '../src/tools/coding.js';

describe('blocking bash that leaves a process behind', () => {
  it('tracks the leftover so kill_shell can stop it', async () => {
    const bash = registerCodingTools().find(t => t.name === 'bash')!;
    const r = await bash.execute({ command: 'sleep 30 >/dev/null 2>&1 & echo started' });
    expect(r.success).toBe(true);
    expect(r.output).toContain('started');
    const id = /tracked as (bg\d+)/.exec(r.output)?.[1];
    expect(id).toBeTruthy();
    expect((await kill.execute({ id })).output).toContain('stopped');
  });

  it('a command ending in & is run as a tracked background command', async () => {
    const bash = registerCodingTools().find(t => t.name === 'bash')!;
    const r = await bash.execute({ command: 'sleep 30 &' });
    const id = idOf(r.output);
    expect((await output.execute({ id })).output).toContain('running');
    await kill.execute({ id });
  });

  it('adds nothing when the command leaves nothing behind', async () => {
    const bash = registerCodingTools().find(t => t.name === 'bash')!;
    const r = await bash.execute({ command: 'echo done' });
    expect(r.output).not.toContain('tracked as');
    expect(r.output).not.toContain('[note]');
  });
});
