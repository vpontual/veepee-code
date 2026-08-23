import { describe, it, expect } from 'vitest';
import { answerText, nonStreamingAnswer } from '../src/llm-answer.js';

/**
 * `07727dc` fixed the reasoning channel in the STREAMING adapter and nowhere
 * else. Seven non-streaming callers kept reading `.content` from the same fleet
 * and silently received `''`: compaction never produced a summary (while the UI
 * printed "Compacted"), every subagent reported `success: false, error: 'max
 * turns reached'`, and the benchmark scored empty strings.
 *
 * Measured against the live gateway 2026-08-23 with the real compaction prompt:
 * content 0 chars, thinking 2,955 chars, done_reason "length".
 */
describe('nonStreamingAnswer', () => {
  it('prefers content when the model actually answered', () => {
    expect(nonStreamingAnswer({ message: { content: 'the summary', thinking: 'let me think' } }))
      .toBe('the summary');
  });

  it('falls back to the reasoning channel when content is empty', () => {
    // The live shape: Ollama-format response from a deepseek_r1-parsed vLLM.
    expect(nonStreamingAnswer({ message: { content: '', thinking: 'FACTS: [a | b]' } }))
      .toBe('FACTS: [a | b]');
  });

  it('accepts every spelling a server might use', () => {
    expect(nonStreamingAnswer({ message: { reasoning_content: 'x' } })).toBe('x');
    expect(nonStreamingAnswer({ message: { reasoning: 'y' } })).toBe('y');
  });

  it('strips an inline trace rather than returning it as the answer', () => {
    expect(nonStreamingAnswer({ message: { content: '<think>hmm</think>done' } })).toBe('done');
    expect(nonStreamingAnswer({ message: { content: 'hmm</think>done' } })).toBe('done');
  });

  it('never throws on a shape it did not expect', () => {
    for (const r of [null, undefined, {}, { message: null }, { message: {} }, 'nonsense']) {
      expect(nonStreamingAnswer(r)).toBe('');
    }
  });

  it('keeps answerText available from its new home', () => {
    expect(answerText('<think>a</think>b')).toBe('b');
  });
});
