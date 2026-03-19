import { describe, it, expect } from 'vitest';
import { autoName } from '../src/sessions.js';
import type { Message } from 'ollama';

describe('autoName', () => {
  it('uses first user message', () => {
    const messages: Message[] = [
      { role: 'user', content: 'fix the login bug' },
      { role: 'assistant', content: 'ok' },
    ];
    expect(autoName(messages)).toBe('fix the login bug');
  });

  it('truncates long messages at word boundary', () => {
    const messages: Message[] = [
      { role: 'user', content: 'this is a very long message that goes on and on about many different things and should be truncated at a reasonable length' },
    ];
    const name = autoName(messages);
    expect(name.length).toBeLessThanOrEqual(44); // 40 + "..."
    expect(name).toContain('...');
  });

  it('returns default for empty messages', () => {
    expect(autoName([])).toBe('Untitled session');
  });

  it('returns default when no user messages', () => {
    const messages: Message[] = [
      { role: 'assistant', content: 'hello' },
    ];
    expect(autoName(messages)).toBe('Untitled session');
  });

  it('handles short messages without truncation', () => {
    const messages: Message[] = [
      { role: 'user', content: 'hi' },
    ];
    expect(autoName(messages)).toBe('hi');
  });
});
