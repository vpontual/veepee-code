import { describe, it, expect } from 'vitest';
import { appReducer, initialState } from '../src/tui/reducer.js';
import { coerceToString } from '../src/tui/index.js';

describe('TUI app reducer', () => {
  it('SET_VIEW transitions view state', () => {
    const state = appReducer(initialState, { type: 'SET_VIEW', view: 'conversation' });
    expect(state.view).toBe('conversation');
  });

  it('ADD_MESSAGE appends to messages', () => {
    const state = appReducer(initialState, {
      type: 'ADD_MESSAGE',
      message: { role: 'user', content: 'hello' },
    });
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].content).toBe('hello');
  });

  it('ADD_MESSAGE trims messages over 500', () => {
    let state = initialState;
    for (let i = 0; i < 501; i++) {
      state = appReducer(state, {
        type: 'ADD_MESSAGE',
        message: { role: 'user', content: `msg ${i}` },
      });
    }
    expect(state.messages.length).toBeLessThanOrEqual(400);
  });

  it('START_STREAM / APPEND_STREAM / END_STREAM lifecycle', () => {
    let state = appReducer(initialState, { type: 'START_STREAM' });
    expect(state.streamActive).toBe(true);
    expect(state.streamBuffer).toBe('');

    state = appReducer(state, { type: 'APPEND_STREAM', text: 'Hello ' });
    state = appReducer(state, { type: 'APPEND_STREAM', text: 'world' });
    expect(state.streamBuffer).toBe('Hello world');

    state = appReducer(state, { type: 'END_STREAM' });
    expect(state.streamActive).toBe(false);
    expect(state.streamBuffer).toBe('');
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].content).toBe('Hello world');
  });

  it('END_STREAM with empty buffer does not add message', () => {
    let state = appReducer(initialState, { type: 'START_STREAM' });
    state = appReducer(state, { type: 'END_STREAM' });
    expect(state.messages).toHaveLength(0);
  });

  it('SET_MODEL updates model info', () => {
    const state = appReducer(initialState, {
      type: 'SET_MODEL',
      name: 'qwen3.5:35b',
      size: '35B',
      role: 'Code',
    });
    expect(state.modelName).toBe('qwen3.5:35b');
    expect(state.modelSize).toBe('35B');
    expect(state.modelRole).toBe('Code');
  });

  it('CLEAR_MESSAGES resets to welcome', () => {
    let state = appReducer(initialState, { type: 'SET_VIEW', view: 'conversation' });
    state = appReducer(state, {
      type: 'ADD_MESSAGE',
      message: { role: 'user', content: 'hello' },
    });
    state = appReducer(state, { type: 'CLEAR_MESSAGES' });
    expect(state.messages).toHaveLength(0);
    expect(state.view).toBe('welcome');
  });

  it('SCROLL_UP / SCROLL_DOWN adjusts offset', () => {
    let state = appReducer(initialState, { type: 'SCROLL_UP', amount: 5 });
    expect(state.scrollOffset).toBe(5);
    state = appReducer(state, { type: 'SCROLL_DOWN', amount: 3 });
    expect(state.scrollOffset).toBe(2);
    state = appReducer(state, { type: 'SCROLL_DOWN', amount: 10 });
    expect(state.scrollOffset).toBe(0);
  });

  it('SET_COMMAND_MENU toggles visibility', () => {
    const state = appReducer(initialState, {
      type: 'SET_COMMAND_MENU',
      visible: true,
      selection: 2,
    });
    expect(state.commandMenuVisible).toBe(true);
    expect(state.commandMenuSelection).toBe(2);
  });

  it('FORCE_RENDER increments tick', () => {
    const state = appReducer(initialState, { type: 'FORCE_RENDER' });
    expect(state.renderTick).toBe(1);
  });

  it('ADD_TOOL_CALL adds to turn tracker', () => {
    let state = appReducer(initialState, {
      type: 'SET_TURN_TRACKER',
      tracker: { startTime: Date.now(), toolCalls: [], tokensEstimate: 0, model: 'test', active: true },
    });
    state = appReducer(state, { type: 'ADD_TOOL_CALL', name: 'grep' });
    expect(state.turnTracker!.toolCalls).toHaveLength(1);
    expect(state.turnTracker!.toolCalls[0].name).toBe('grep');
    expect(state.turnTracker!.toolCalls[0].status).toBe('running');
  });

  it('ADD_TOOL_CALL is no-op without tracker', () => {
    const state = appReducer(initialState, { type: 'ADD_TOOL_CALL', name: 'grep' });
    expect(state.turnTracker).toBeNull();
  });
});

describe('coerceToString — defense against [object Object] leaks', () => {
  it('passes strings through unchanged', () => {
    expect(coerceToString('hello')).toBe('hello');
    expect(coerceToString('')).toBe('');
    expect(coerceToString('multi\nline')).toBe('multi\nline');
  });

  it('returns empty string for null/undefined (preserves || \'\' fallback semantics)', () => {
    expect(coerceToString(null)).toBe('');
    expect(coerceToString(undefined)).toBe('');
  });

  it('extracts message from Error instances', () => {
    expect(coerceToString(new Error('boom'))).toBe('boom');
    expect(coerceToString(new TypeError('bad type'))).toBe('bad type');
  });

  it('JSON-serializes plain objects instead of producing [object Object]', () => {
    expect(coerceToString({ foo: 'bar' })).toBe('{"foo":"bar"}');
    expect(coerceToString({ a: 1, b: [2, 3] })).toBe('{"a":1,"b":[2,3]}');
  });

  it('handles circular references without throwing', () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj.self = obj;
    const out = coerceToString(obj);
    expect(out).toContain('"a":1');
    expect(out).toContain('[circular]');
  });

  it('coerces numbers and booleans sensibly', () => {
    expect(coerceToString(42)).toBe('42');
    expect(coerceToString(true)).toBe('true');
    expect(coerceToString(false)).toBe('false');
  });

  it('never returns the literal "[object Object]" for plain objects', () => {
    expect(coerceToString({})).not.toBe('[object Object]');
    expect(coerceToString({ x: 1 })).not.toBe('[object Object]');
  });
});
