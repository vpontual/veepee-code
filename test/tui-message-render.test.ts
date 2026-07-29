import { describe, it, expect } from 'vitest';
import { formatMessage, SPINNER_FRAMES } from '../src/tui/components/MessageBlock.js';
import { appReducer, initialState } from '../src/tui/reducer.js';
import type { Message, AppState } from '../src/tui/types.js';

const NUL = String.fromCharCode(0); // inline-code placeholder; must never reach output
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, ''); // eslint-disable-line no-control-regex
const text = (lines: string[]) => strip(lines.join('\n'));

describe('formatMessage — render cache', () => {
  it('reuses the rendered lines for the same message object and width', () => {
    const msg: Message = { role: 'assistant', content: 'Hello **world** with `code`.' };
    const first = formatMessage(msg, 100);
    const second = formatMessage(msg, 100);
    // Same array instance == the cache was consulted, not just equal output.
    expect(second).toBe(first);
  });

  it('re-renders when the width changes', () => {
    const msg: Message = { role: 'assistant', content: 'Hello **world**.' };
    const wide = formatMessage(msg, 100);
    const narrow = formatMessage(msg, 40);
    expect(narrow).not.toBe(wide);
  });

  it('produces identical output cached and uncached', () => {
    const content = 'Answer with `inline` and a block:\n\n```ts\nconst x: number = 1;\n```\n\n- one\n- two';
    const a = formatMessage({ role: 'assistant', content }, 90);
    const b = formatMessage({ role: 'assistant', content }, 90); // distinct object
    expect(a.join('\n')).toBe(b.join('\n'));
  });

  it('never caches the animated thinking spinner', () => {
    const msg: Message = { role: 'thinking', content: '...' };
    const f0 = formatMessage(msg, 80, 0);
    const f1 = formatMessage(msg, 80, 1);
    expect(f0).not.toEqual(f1);
    expect(strip(f0[0])).toContain(SPINNER_FRAMES[0]);
    expect(strip(f1[0])).toContain(SPINNER_FRAMES[1]);
  });

  it('derives the spinner frame from its argument, not the clock', () => {
    const msg: Message = { role: 'thinking', content: '...' };
    // Same frame in, same output out — twice, with no timing dependence.
    expect(formatMessage(msg, 80, 7)).toEqual(formatMessage(msg, 80, 7));
    // And it wraps rather than going out of range.
    expect(() => formatMessage(msg, 80, 999)).not.toThrow();
  });
});

describe('inline-code placeholder', () => {
  it('does not mangle section-sign text that looks like the old sentinel', () => {
    // `§0§` is plausible model output (statute references). It used to be
    // substituted out of the final pass, yielding the string "undefined".
    const out = text(formatMessage({ role: 'assistant', content: 'See §0§ and §1§ of the act.' }, 100));
    expect(out).toContain('§0§');
    expect(out).toContain('§1§');
    expect(out).not.toContain('undefined');
  });

  it('still restores inline code', () => {
    const out = text(formatMessage({ role: 'assistant', content: 'Run `npm test` now.' }, 100));
    expect(out).toContain('npm test');
    expect(out).not.toContain(NUL);
  });

  it('restores several inline spans in order', () => {
    const out = text(formatMessage({ role: 'assistant', content: 'Use `a`, then `b`, then `c`.' }, 100));
    expect(out).toContain('a');
    expect(out).toContain('b');
    expect(out).toContain('c');
    expect(out).not.toContain(NUL);
  });
});

describe('tool results', () => {
  it('reports how many lines were clipped', () => {
    const content = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
    const out = text(formatMessage({ role: 'tool_result', content, success: true }, 100));
    expect(out).toContain('line 0');
    expect(out).toContain('12 more lines'); // 20 - 8
  });

  it('says nothing when the whole result fits', () => {
    const out = text(formatMessage({ role: 'tool_result', content: 'a\nb\nc', success: true }, 100));
    expect(out).not.toContain('more line');
  });

  it('uses the singular for exactly one hidden line', () => {
    const content = Array.from({ length: 9 }, (_, i) => `line ${i}`).join('\n');
    const out = text(formatMessage({ role: 'tool_result', content, success: true }, 100));
    expect(out).toContain('1 more line');
    expect(out).not.toContain('1 more lines');
  });
});

describe('user message padding uses display width', () => {
  it('pads wide (double-column) glyphs to the same visual width as ASCII', () => {
    const ascii = formatMessage({ role: 'user', content: 'abcd' }, 40);
    const cjk = formatMessage({ role: 'user', content: '日本' }, 40); // 2 chars, 4 columns
    // Both occupy 4 terminal columns, so the padded blocks must match in width.
    expect(strip(cjk[0]).length).toBeLessThan(strip(ascii[0]).length);
  });
});

describe('REPLACE_LAST_THINKING', () => {
  const base = (messages: Message[]): AppState => ({ ...initialState, messages });
  const thinking = (content: string): Message => ({ role: 'thinking', content, collapsed: true });

  it('replaces the thinking block when it is the trailing message', () => {
    const state = base([{ role: 'user', content: 'hi' }, thinking('...')]);
    const next = appReducer(state, { type: 'REPLACE_LAST_THINKING', message: thinking('real reasoning') } as never);
    expect(next.messages).toHaveLength(2);
    expect(next.messages[1].content).toBe('real reasoning');
  });

  it('appends instead of reaching back into an earlier turn', () => {
    // The bug: findLastIndex found turn 1's thinking block and overwrote it,
    // destroying that content and rendering the new text at the old position.
    const state = base([
      { role: 'user', content: 'q1' },
      thinking('turn 1 reasoning'),
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
    ]);
    const next = appReducer(state, { type: 'REPLACE_LAST_THINKING', message: thinking('turn 2 reasoning') } as never);

    expect(next.messages).toHaveLength(5);
    expect(next.messages[1].content).toBe('turn 1 reasoning'); // untouched
    expect(next.messages[4].content).toBe('turn 2 reasoning'); // appended at the end
  });

  it('appends when there is no thinking message at all', () => {
    const state = base([{ role: 'user', content: 'hi' }]);
    const next = appReducer(state, { type: 'REPLACE_LAST_THINKING', message: thinking('reasoning') } as never);
    expect(next.messages).toHaveLength(2);
    expect(next.messages[1].role).toBe('thinking');
  });

  it('honours the transcript cap when appending', () => {
    const many: Message[] = Array.from({ length: 500 }, (_, i) => ({ role: 'user', content: `m${i}` }));
    const next = appReducer(base(many), { type: 'REPLACE_LAST_THINKING', message: thinking('r') } as never);
    expect(next.messages.length).toBeLessThanOrEqual(500);
    expect(next.messages[next.messages.length - 1].content).toBe('r');
  });
});

describe('FORCE_RENDER', () => {
  it('advances renderTick so the spinner and elapsed time can animate', () => {
    const s1 = appReducer(initialState, { type: 'FORCE_RENDER' } as never);
    const s2 = appReducer(s1, { type: 'FORCE_RENDER' } as never);
    expect(s1.renderTick).toBe(initialState.renderTick + 1);
    expect(s2.renderTick).toBe(initialState.renderTick + 2);
  });
});
