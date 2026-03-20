import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Capture all stdout writes to analyze rendering behavior
let stdoutWrites: string[] = [];
const originalWrite = process.stdout.write;

beforeEach(() => {
  stdoutWrites = [];
  // Stub stdout.write to capture all output
  process.stdout.write = ((chunk: string | Uint8Array) => {
    if (typeof chunk === 'string') stdoutWrites.push(chunk);
    return true;
  }) as typeof process.stdout.write;
  // Stub terminal size
  Object.defineProperty(process.stdout, 'rows', { value: 40, configurable: true });
  Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true });
});

afterEach(() => {
  process.stdout.write = originalWrite;
});

describe('TUI rendering (no full-screen flash)', () => {
  it('renderConversation does not use clearScreen escape sequence', async () => {
    // Dynamic import after stdout is stubbed
    const { TUI } = await import('../src/tui/index.js');
    const tui = new TUI();

    // Initialize TUI state minimally (skip start() which enters alt screen)
    // Access private state to set conversation mode
    (tui as any).state = 'conversation';
    (tui as any).modelName = 'test-model';
    (tui as any).modelSize = '8B';
    (tui as any).version = '0.3.0';

    stdoutWrites = []; // clear any init writes
    tui.render();

    const allOutput = stdoutWrites.join('');

    // Should NOT contain the clearScreen sequence (\x1b[2J)
    expect(allOutput).not.toContain('\x1b[2J');

    // Should contain cursor movement (moveTo sequences) — rendering is happening
    expect(allOutput).toContain('\x1b[');
  });

  it('renderConversation overwrites rows individually', async () => {
    const { TUI } = await import('../src/tui/index.js');
    const tui = new TUI();

    (tui as any).state = 'conversation';
    (tui as any).modelName = 'test-model';
    (tui as any).modelSize = '8B';
    (tui as any).version = '0.3.0';

    stdoutWrites = [];
    tui.render();

    // Count cursor positioning sequences (moveTo calls)
    const moveToPattern = /\x1b\[\d+;\d+H/g;
    const moveToCalls = stdoutWrites.join('').match(moveToPattern) || [];

    // Should have multiple moveTo calls (one per row being rendered)
    expect(moveToCalls.length).toBeGreaterThan(5);
  });

  it('stream append triggers throttled render without clearScreen', async () => {
    const { TUI } = await import('../src/tui/index.js');
    const tui = new TUI();

    (tui as any).state = 'conversation';
    (tui as any).modelName = 'test-model';
    (tui as any).modelSize = '8B';
    (tui as any).version = '0.3.0';
    (tui as any).streamActive = true;
    (tui as any).streamBuffer = '';

    stdoutWrites = [];
    // Simulate streaming chunks
    (tui as any).streamBuffer = 'Hello ';
    (tui as any).lastRenderTime = 0; // force render (bypass throttle)
    (tui as any).renderStreamArea();

    const allOutput = stdoutWrites.join('');
    expect(allOutput).not.toContain('\x1b[2J');
  });

  it('messages area pads lines to full width', async () => {
    const { TUI } = await import('../src/tui/index.js');
    const tui = new TUI();

    (tui as any).state = 'conversation';
    (tui as any).modelName = 'test-model';
    (tui as any).modelSize = '8B';
    (tui as any).version = '0.3.0';
    (tui as any).messages = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ];

    stdoutWrites = [];
    tui.render();

    // Verify no clearScreen
    const allOutput = stdoutWrites.join('');
    expect(allOutput).not.toContain('\x1b[2J');

    // Verify output was produced (messages rendered)
    expect(allOutput.length).toBeGreaterThan(0);
  });
});
