import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

describe('Remote Connect source invariants', () => {
  it('broadcasts remote user messages as a dedicated user_message event', () => {
    const source = readFileSync(new URL('../src/rc.ts', import.meta.url), 'utf-8');

    expect(source).toContain("broadcast('user_message', { content: data.message });");
    expect(source).not.toContain("broadcast('text', { role: 'user', content: data.message });");
  });

  it('exposes an explicit RC abort endpoint that calls agent.abort()', () => {
    const source = readFileSync(new URL('../src/rc.ts', import.meta.url), 'utf-8');

    expect(source).toContain("if (path === '/rc/abort' && req.method === 'POST')");
    expect(source).toContain('agent.abort();');
  });

  it('resets message history before replaying history after reconnect', () => {
    const source = readFileSync(new URL('../src/rc-ui.ts', import.meta.url), 'utf-8');

    expect(source).toContain('let historyResetPending = false;');
    expect(source).toContain("if (historyResetPending) {");
    expect(source).toContain("document.getElementById('messages').innerHTML = '';");
  });

  it('renders remote user_message events as user bubbles and stop uses /rc/abort', () => {
    const source = readFileSync(new URL('../src/rc-ui.ts', import.meta.url), 'utf-8');

    expect(source).toContain("eventSource.addEventListener('user_message'");
    expect(source).toContain("addMessage('user', data.content);");
    expect(source).toContain("fetch(API_BASE + '/rc/abort'");
    expect(source).not.toContain("body: JSON.stringify({ message: '/stop' })");
  });
});
