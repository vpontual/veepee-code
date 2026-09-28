/**
 * A task list the model keeps for itself (`todo_write`).
 *
 * The cheapest known fix for a model losing its place on a long task: it
 * writes the steps down, marks one in progress, and ticks them off. Small
 * open-weight models drift far more than frontier ones, so the list is also
 * shown back to the model on every turn (ContextManager's volatile block) and
 * survives compaction, and the agent nudges once if a turn ends with items
 * still open.
 *
 * Same shape as Claude Code's TodoWrite (content + status, the whole list
 * rewritten each call), which current models are already trained to use.
 */
import { z } from 'zod';
import type { ToolDef } from './tools/types.js';
import { ok, fail } from './tools/types.js';

export type TodoStatus = 'pending' | 'in_progress' | 'completed';
export interface TodoItem { content: string; status: TodoStatus }

const MARK: Record<TodoStatus, string> = { pending: '[ ]', in_progress: '[~]', completed: '[x]' };

export class TodoList {
  private items: TodoItem[] = [];

  set(items: TodoItem[]): void {
    this.items = items.map(i => ({ content: i.content.trim(), status: i.status }));
  }

  all(): TodoItem[] {
    return this.items.map(i => ({ ...i }));
  }

  open(): TodoItem[] {
    return this.items.filter(i => i.status !== 'completed');
  }

  render(): string {
    if (this.items.length === 0) return '(empty)';
    return this.items.map(i => `${MARK[i.status]} ${i.content}`).join('\n');
  }

  /** The list as the model sees it each turn; empty when there is no list. */
  contextBlock(): string {
    if (this.items.length === 0) return '';
    const done = this.items.length - this.open().length;
    return `\n\n## Your task list (${done}/${this.items.length} done — update it with todo_write)\n${this.render()}\n`;
  }
}

/** What a model meant by its status word. */
function normalizeStatus(v: unknown): TodoStatus {
  const s = String(v ?? '').toLowerCase().replace(/[\s-]+/g, '_');
  if (['completed', 'complete', 'done', 'finished', 'fixed', 'ok'].includes(s)) return 'completed';
  if (['in_progress', 'inprogress', 'doing', 'active', 'started', 'working', 'current'].includes(s)) return 'in_progress';
  return 'pending';
}

export function buildTodoTool(list: TodoList): ToolDef {
  return {
    name: 'todo_write',
    description:
      'Keep a task list for multi-step work. Call it at the start of any task with 3+ steps, then again whenever a step starts or finishes. ' +
      'Send the WHOLE list every time (it replaces the previous one). Exactly one item should be in_progress while you work; mark an item completed as soon as it is done, not in a batch at the end. ' +
      'Skip it for single-step or conversational requests.',
    schema: z.object({
      todos: z.array(z.object({
        content: z.string().optional().describe('The step, as a short imperative ("Fix the off-by-one in range.ts")'),
        status: z.string().optional().describe('pending, in_progress or completed'),
      }).passthrough()).describe('The complete task list'),
    }),
    source: 'local',
    timeoutMs: 5_000,
    execute: async (params) => {
      // Lenient on purpose. A task list is a crutch; it must never be what sinks
      // a run. gemma4 (AGX) writes `description` for the step and statuses like
      // "todo"; rejected, it resent the same call until the loop guard ended the
      // job — twice in one Nightly Engineer night. Normalize what it meant.
      const raw = (Array.isArray(params.todos) ? params.todos : []) as Array<Record<string, unknown>>;
      const todos: TodoItem[] = [];
      for (const r of raw) {
        const content = [r.content, r.description, r.task, r.title, r.text, r.step].find(v => typeof v === 'string' && v.trim()) as string | undefined;
        if (!content) continue;
        todos.push({ content, status: normalizeStatus(r.status) });
      }
      if (raw.length > 0 && todos.length === 0) {
        return fail('Each item needs its text in "content" (e.g. {"content": "Fix the bug", "status": "in_progress"}).');
      }
      const notes: string[] = [];
      let seenActive = false;
      for (const t of todos) {
        if (t.status !== 'in_progress') continue;
        if (seenActive) { t.status = 'pending'; notes.push(`"${t.content}" set to pending: only one item is in progress at a time.`); }
        seenActive = true;
      }
      // Resending the unchanged list is how small models spin: say so plainly.
      if (todos.length > 0 && JSON.stringify(todos) === JSON.stringify(list.all())) {
        const current = todos.find(t => t.status === 'in_progress') ?? todos.find(t => t.status === 'pending');
        return ok(`No change — the list is already this. ${current ? `Do "${current.content}" now with your other tools, and ` : ''}call todo_write again only when a step's status changes.`);
      }
      list.set(todos);
      const open = list.open().length;
      const tail = todos.length === 0
        ? 'Task list cleared.'
        : open === 0
          ? 'All items completed.'
          : `${open} item${open === 1 ? '' : 's'} left.`;
      return ok(`${list.render()}\n\n${tail}${notes.length ? `\n${notes.join('\n')}` : ''}`);
    },
  };
}
