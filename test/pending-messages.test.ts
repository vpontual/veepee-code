import { describe, it, expect } from 'vitest';
import { appReducer, initialState } from '../src/tui/reducer.js';
import type { AppState } from '../src/tui/types.js';

function withQueued(text: string, cursor?: number): AppState {
  return { ...initialState, queuedInput: text, queuedCursor: cursor ?? text.length };
}

describe('pending-messages reducer', () => {
  it('initial state has empty steering and followUp queues', () => {
    expect(initialState.pendingMessages).toEqual({ steering: [], followUp: [] });
  });

  it('QUEUE_STEERING appends and clears the typing buffer', () => {
    const before = withQueued('use the test fixtures');
    const after = appReducer(before, { type: 'QUEUE_STEERING', text: 'use the test fixtures' });
    expect(after.pendingMessages.steering).toEqual(['use the test fixtures']);
    expect(after.pendingMessages.followUp).toEqual([]);
    expect(after.queuedInput).toBe('');
    expect(after.queuedCursor).toBe(0);
  });

  it('QUEUE_FOLLOWUP appends to followUp only', () => {
    const after = appReducer(initialState, { type: 'QUEUE_FOLLOWUP', text: 'then run tests' });
    expect(after.pendingMessages.followUp).toEqual(['then run tests']);
    expect(after.pendingMessages.steering).toEqual([]);
  });

  it('preserves submission order across multiple queues', () => {
    let s = appReducer(initialState, { type: 'QUEUE_STEERING', text: 'one' });
    s = appReducer(s, { type: 'QUEUE_STEERING', text: 'two' });
    s = appReducer(s, { type: 'QUEUE_FOLLOWUP', text: 'three' });
    expect(s.pendingMessages.steering).toEqual(['one', 'two']);
    expect(s.pendingMessages.followUp).toEqual(['three']);
  });

  it('ignores empty/whitespace-only messages', () => {
    expect(appReducer(initialState, { type: 'QUEUE_STEERING', text: '' }).pendingMessages.steering).toEqual([]);
    expect(appReducer(initialState, { type: 'QUEUE_STEERING', text: '   ' }).pendingMessages.steering).toEqual([]);
    expect(appReducer(initialState, { type: 'QUEUE_FOLLOWUP', text: '\n\t' }).pendingMessages.followUp).toEqual([]);
  });

  it('POP_PENDING_TO_INPUT pops most-recent follow-up first into typing buffer', () => {
    let s = appReducer(initialState, { type: 'QUEUE_STEERING', text: 'first' });
    s = appReducer(s, { type: 'QUEUE_FOLLOWUP', text: 'second' });
    s = appReducer(s, { type: 'QUEUE_FOLLOWUP', text: 'third' });
    s = appReducer(s, { type: 'POP_PENDING_TO_INPUT' });
    expect(s.queuedInput).toBe('third');
    expect(s.pendingMessages.followUp).toEqual(['second']);
    expect(s.pendingMessages.steering).toEqual(['first']);
  });

  it('POP_PENDING_TO_INPUT falls back to steering when follow-up is empty', () => {
    let s = appReducer(initialState, { type: 'QUEUE_STEERING', text: 'a' });
    s = appReducer(s, { type: 'QUEUE_STEERING', text: 'b' });
    s = appReducer(s, { type: 'POP_PENDING_TO_INPUT' });
    expect(s.queuedInput).toBe('b');
    expect(s.pendingMessages.steering).toEqual(['a']);
    expect(s.pendingMessages.followUp).toEqual([]);
  });

  it('POP_PENDING_TO_INPUT is a no-op when both queues are empty', () => {
    const s = appReducer(initialState, { type: 'POP_PENDING_TO_INPUT' });
    expect(s).toBe(initialState);
  });

  it('CLEAR_PENDING empties both queues without touching typing buffer', () => {
    let s = appReducer(withQueued('still typing'), { type: 'QUEUE_STEERING', text: 'committed' });
    s = appReducer(s, { type: 'QUEUE_FOLLOWUP', text: 'committed too' });
    // Re-add typing buffer (was cleared by QUEUE_STEERING)
    s = appReducer(s, { type: 'SET_QUEUED_INPUT', text: 'still typing', cursor: 12 });
    s = appReducer(s, { type: 'CLEAR_PENDING' });
    expect(s.pendingMessages).toEqual({ steering: [], followUp: [] });
    expect(s.queuedInput).toBe('still typing');
  });

  it('DRAIN_STEERING empties only steering', () => {
    let s = appReducer(initialState, { type: 'QUEUE_STEERING', text: 'a' });
    s = appReducer(s, { type: 'QUEUE_FOLLOWUP', text: 'b' });
    s = appReducer(s, { type: 'DRAIN_STEERING' });
    expect(s.pendingMessages.steering).toEqual([]);
    expect(s.pendingMessages.followUp).toEqual(['b']);
  });

  it('DRAIN_FOLLOWUP empties only followUp', () => {
    let s = appReducer(initialState, { type: 'QUEUE_STEERING', text: 'a' });
    s = appReducer(s, { type: 'QUEUE_FOLLOWUP', text: 'b' });
    s = appReducer(s, { type: 'DRAIN_FOLLOWUP' });
    expect(s.pendingMessages.followUp).toEqual([]);
    expect(s.pendingMessages.steering).toEqual(['a']);
  });

  it('round-trips across multiple drains and queues', () => {
    let s = appReducer(initialState, { type: 'QUEUE_STEERING', text: 'one' });
    s = appReducer(s, { type: 'DRAIN_STEERING' });
    s = appReducer(s, { type: 'QUEUE_STEERING', text: 'two' });
    expect(s.pendingMessages.steering).toEqual(['two']);
  });
});
