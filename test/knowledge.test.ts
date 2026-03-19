import { describe, it, expect } from 'vitest';
import { KnowledgeState } from '../src/knowledge.js';

describe('KnowledgeState', () => {
  it('initializes with empty data', () => {
    const ks = new KnowledgeState('test-session');
    const data = ks.getData();
    expect(data.turn).toBe(0);
    expect(data.decisions).toEqual([]);
    expect(data.filesRead).toEqual([]);
    expect(data.filesModified).toEqual([]);
    expect(data.facts).toEqual([]);
    expect(data.errors).toEqual([]);
  });

  it('updates turn count on each update', () => {
    const ks = new KnowledgeState('test');
    ks.update('hello', 'hi there', undefined, []);
    expect(ks.getTurn()).toBe(1);
    ks.update('do something', 'ok', undefined, []);
    expect(ks.getTurn()).toBe(2);
  });

  it('extracts user intent from message', () => {
    const ks = new KnowledgeState('test');
    ks.update('fix the auth module', null, undefined, []);
    expect(ks.getData().userIntent).toBe('fix the auth module');
    expect(ks.getData().currentTask).toBe('fix the auth module');
  });

  it('truncates long user intent', () => {
    const ks = new KnowledgeState('test');
    const longMsg = 'a'.repeat(200);
    ks.update(longMsg, null, undefined, []);
    expect(ks.getData().userIntent.length).toBeLessThanOrEqual(120);
  });

  it('extracts decisions from assistant text', () => {
    const ks = new KnowledgeState('test');
    ks.update(null, "I'll use JWT for authentication.", undefined, []);
    expect(ks.getData().decisions).toContain('JWT for authentication');
  });

  it('tracks file reads from tool calls', () => {
    const ks = new KnowledgeState('test');
    const toolCalls = [{ function: { name: 'read_file', arguments: { path: 'src/auth.ts' } } }] as any;
    const toolResults = [{ name: 'read_file', content: 'file content', success: true }];
    ks.update(null, null, toolCalls, toolResults);
    expect(ks.getData().filesRead).toContain('src/auth.ts');
  });

  it('tracks file modifications from tool calls', () => {
    const ks = new KnowledgeState('test');
    const toolCalls = [{ function: { name: 'write_file', arguments: { path: 'src/new.ts' } } }] as any;
    const toolResults = [{ name: 'write_file', content: 'written', success: true }];
    ks.update(null, null, toolCalls, toolResults);
    expect(ks.getData().filesModified).toContain('src/new.ts');
  });

  it('tracks errors from tool results', () => {
    const ks = new KnowledgeState('test');
    ks.update(null, null, undefined, [
      { name: 'bash', content: 'Error: command not found', success: false },
    ]);
    expect(ks.getData().errors.length).toBe(1);
    expect(ks.getData().errors[0]).toContain('Error: command not found');
  });

  it('bounds array sizes', () => {
    const ks = new KnowledgeState('test');
    for (let i = 0; i < 30; i++) {
      const toolCalls = [{ function: { name: 'read_file', arguments: { path: `file${i}.ts` } } }] as any;
      ks.update(null, null, toolCalls, [{ name: 'read_file', content: 'ok', success: true }]);
    }
    expect(ks.getData().filesRead.length).toBeLessThanOrEqual(20);
  });

  it('handles updateMemory for facts', () => {
    const ks = new KnowledgeState('test');
    ks.updateMemory('fact', 'project uses pnpm');
    expect(ks.getData().facts).toContain('project uses pnpm');
  });

  it('handles updateMemory for decisions', () => {
    const ks = new KnowledgeState('test');
    ks.updateMemory('decision', 'use Redis for caching');
    expect(ks.getData().decisions).toContain('use Redis for caching');
  });

  it('handles updateMemory for project', () => {
    const ks = new KnowledgeState('test');
    ks.updateMemory('project', 'MyApp');
    expect(ks.getData().project).toBe('MyApp');
  });

  it('handles updateMemory for custom keys', () => {
    const ks = new KnowledgeState('test');
    ks.updateMemory('db_version', 'PostgreSQL 17');
    expect(ks.getData().facts).toContain('db_version: PostgreSQL 17');
  });

  it('does not duplicate facts', () => {
    const ks = new KnowledgeState('test');
    ks.updateMemory('fact', 'same fact');
    ks.updateMemory('fact', 'same fact');
    expect(ks.getData().facts.filter(f => f === 'same fact').length).toBe(1);
  });

  describe('serialization', () => {
    it('serializes to compact format', () => {
      const ks = new KnowledgeState('test');
      ks.updateMemory('project', 'TestProject');
      ks.update('fix auth', "I'll use JWT.", undefined, []);

      const serialized = ks.serialize();
      expect(serialized).toContain('PROJECT: TestProject');
      expect(serialized).toContain('TURN: 1');
      expect(serialized).toContain('USER_INTENT: fix auth');
    });

    it('deserializes back correctly', () => {
      const text = `PROJECT: TestProject
CWD: /home/user/project
USER_INTENT: fix the login
CURRENT_TASK: fix the login
DECISIONS: [use JWT, add rate limiting]
FILES_READ: [src/auth.ts, src/login.ts]
FACTS: [uses Express 4.x]
TURN: 5`;

      const data = KnowledgeState.deserialize(text);
      expect(data.project).toBe('TestProject');
      expect(data.cwd).toBe('/home/user/project');
      expect(data.turn).toBe(5);
      expect(data.decisions).toEqual(['use JWT', 'add rate limiting']);
      expect(data.filesRead).toEqual(['src/auth.ts', 'src/login.ts']);
      expect(data.facts).toEqual(['uses Express 4.x']);
    });

    it('toSystemPromptBlock is empty at turn 0', () => {
      const ks = new KnowledgeState('test');
      expect(ks.toSystemPromptBlock()).toBe('');
    });

    it('toSystemPromptBlock has content after updates', () => {
      const ks = new KnowledgeState('test');
      ks.update('hello', 'hi', undefined, []);
      const block = ks.toSystemPromptBlock();
      expect(block).toContain('Knowledge State');
      expect(block).toContain('TURN: 1');
    });
  });
});
