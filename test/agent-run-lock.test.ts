import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { Agent, AgentBusyError, type AgentEvent } from '../src/agent.js';

/**
 * The run lock is what stops two callers (e.g. POST /v1/chat/completions and
 * POST /rc/send) from interleaving into the one shared conversation context.
 * We exercise the lock through the real Agent.run/withRunLock plumbing by
 * standing in a controllable inner generator, so these are behavioural tests
 * of the guard itself rather than assertions about source text.
 */
/** The private surface we stand in for. `runLock`/`_run` are private on Agent,
 *  so we reach them structurally rather than through the class type. */
interface LockProbe {
  runLock: boolean;
  _run: (msg?: string) => AsyncGenerator<AgentEvent>;
  run: (msg: string, opts?: unknown) => AsyncGenerator<AgentEvent>;
  isRunning: () => boolean;
}

function makeProbe(): LockProbe {
  return Object.create(Agent.prototype) as unknown as LockProbe;
}

function lockHarness() {
  const agent = makeProbe();
  agent.runLock = false;

  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });

  agent._run = async function* () {
    yield { type: 'text', content: 'start' } as AgentEvent;
    await gate;
    yield { type: 'done' } as AgentEvent;
  };

  return { agent, release };
}

describe('Agent run lock', () => {
  it('reports not running before any run', () => {
    const { agent } = lockHarness();
    expect(agent.isRunning()).toBe(false);
  });

  it('rejects a second run while the first is in flight', async () => {
    const { agent, release } = lockHarness();

    const first = agent.run('one');
    const drained = (async () => { for await (const _ of first) { /* drain */ } })();

    // Pull the first event so the inner generator is genuinely mid-run.
    await Promise.resolve();
    expect(agent.isRunning()).toBe(true);

    expect(() => agent.run('two')).toThrow(AgentBusyError);
    expect(() => agent.run('two')).toThrow(/agent busy/i);

    release();
    await drained;
  });

  it('claims the lock synchronously, leaving no await gap to race through', () => {
    // run() must NOT be an async generator: an async generator body does not
    // execute until the first next(), so two callers could both get past the
    // check before either sets the flag.
    const { agent } = lockHarness();
    agent.run('one'); // never iterated
    expect(agent.isRunning()).toBe(true);
  });

  it('releases the lock after the run completes', async () => {
    const { agent, release } = lockHarness();
    const stream = agent.run('one');
    const drained = (async () => { for await (const _ of stream) { /* drain */ } })();
    release();
    await drained;

    expect(agent.isRunning()).toBe(false);
    // ...and a subsequent run is accepted again.
    expect(() => agent.run('two')).not.toThrow();
  });

  it('releases the lock when the consumer abandons the stream early', async () => {
    const { agent } = lockHarness();
    const stream = agent.run('one');

    for await (const _ of stream) {
      break; // `break` triggers .return() -> the finally in withRunLock
    }

    expect(agent.isRunning()).toBe(false);
  });

  it('releases the lock when the inner run throws', async () => {
    const agent = makeProbe();
    agent.runLock = false;
    agent._run = async function* () {
      yield { type: 'text', content: 'boom' } as AgentEvent;
      throw new Error('inner failure');
    };

    const stream = agent.run('one');
    await expect((async () => { for await (const _ of stream) { /* drain */ } })())
      .rejects.toThrow('inner failure');

    expect(agent.isRunning()).toBe(false);
  });
});

describe('AgentBusyError', () => {
  it('carries a machine-readable code', () => {
    const err = new AgentBusyError();
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('AGENT_BUSY');
    expect(err.name).toBe('AgentBusyError');
  });
});

describe('busy handling at the HTTP entry points', () => {
  it('api.ts claims the agent before writing SSE headers', () => {
    const source = readFileSync(new URL('../src/api.ts', import.meta.url), 'utf-8');
    const claim = source.indexOf('stream = agent.run(userContent');
    const headers = source.indexOf("'Content-Type': 'text/event-stream'");
    expect(claim).toBeGreaterThan(-1);
    expect(headers).toBeGreaterThan(-1);
    // A 409 is impossible once 200 + SSE headers are on the wire.
    expect(claim).toBeLessThan(headers);
    expect(source).toContain('sendBusy(res)');
  });

  it('api.ts answers 409 with a retry hint', () => {
    const source = readFileSync(new URL('../src/api.ts', import.meta.url), 'utf-8');
    expect(source).toContain('sendJson(res, 409');
    expect(source).toContain("'AGENT_BUSY'");
  });

  it('rc.ts rejects a busy /rc/send before acknowledging it', () => {
    const source = readFileSync(new URL('../src/rc.ts', import.meta.url), 'utf-8');
    const busy = source.indexOf('agent.isRunning()');
    const ack = source.indexOf('// Acknowledge receipt immediately');
    expect(busy).toBeGreaterThan(-1);
    expect(ack).toBeGreaterThan(-1);
    expect(busy).toBeLessThan(ack);
  });

  it('the TUI bails out before echoing a message it cannot run', () => {
    const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf-8');
    const busy = source.indexOf('if (agent.isRunning())');
    const echo = source.indexOf('tui.addUserMessage(text)');
    expect(busy).toBeGreaterThan(-1);
    expect(echo).toBeGreaterThan(-1);
    expect(busy).toBeLessThan(echo);
  });
});
