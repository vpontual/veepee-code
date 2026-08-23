import { describe, it, expect } from 'vitest';
import { ContextManager } from '../src/context.js';
import { buildSkillInvokeTool } from '../src/skills.js';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * Everything in the system prompt and in a tool description is paid on EVERY
 * request. Both of the things capped here had grown unbounded and unmeasured:
 * operator context reached 30,026 chars of a 48,073-char system prompt (~8.6k
 * tokens/turn, larger than vcode's own instructions plus the project tree plus
 * the project instructions), and the skills index rides in `skill_invoke`'s
 * description at a measured ~531 chars per skill against a comment budgeting
 * 50–80 — while `teacher-escalation` writes new skills into that same directory
 * automatically and nothing prunes.
 */
describe('prompt payload is bounded', () => {
  it('keeps the whole system prompt under a sane per-turn cost', () => {
    const c = new ContextManager();
    c.setSystemPrompt('qwen3');
    const chars = c.getSystemPrompt().length;
    // ~9.6k tokens at 3.5 chars/token, down from ~13.7k.
    expect(chars).toBeLessThan(40_000);
  });

  it('never truncates the behavioural rules to fit the index', () => {
    const rules = join(process.env.HOME || '~', 'Nextcloud', 'pinky', 'identity', 'rules.md');
    if (!existsSync(rules)) return; // not this machine — nothing to assert
    const c = new ContextManager();
    c.setSystemPrompt('qwen3');
    const prompt = c.getSystemPrompt();
    const body = readFileSync(rules, 'utf-8').trim();
    const tail = body.slice(-120);
    // Rules are behaviour; the cross-machine INDEX is what gets deferred to a
    // pointer, because a lookup can be done on demand and a rule cannot.
    expect(prompt).toContain(tail);
  });

  it('bounds the skills index however many skills exist', () => {
    const tool = buildSkillInvokeTool(process.cwd(), ['bash', 'read_file', 'write_file', 'edit_file']);
    if (!tool) return; // no skills on this machine
    expect(tool.description.length).toBeLessThan(9_000);
    for (const l of tool.description.split('\n').filter(l => l.startsWith('  • '))) {
      expect(l.length).toBeLessThanOrEqual(200);
    }
  });
});
