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

export function buildTodoTool(list: TodoList): ToolDef {
  return {
    name: 'todo_write',
    description:
      'Keep a task list for multi-step work. Call it at the start of any task with 3+ steps, then again whenever a step starts or finishes. ' +
      'Send the WHOLE list every time (it replaces the previous one). Exactly one item should be in_progress while you work; mark an item completed as soon as it is done, not in a batch at the end. ' +
      'Skip it for single-step or conversational requests.',
    schema: z.object({
      todos: z.array(z.object({
        content: z.string().min(1).describe('The step, as a short imperative ("Fix the off-by-one in range.ts")'),
        status: z.enum(['pending', 'in_progress', 'completed']),
      })).describe('The complete task list'),
    }),
    source: 'local',
    timeoutMs: 5_000,
    execute: async (params) => {
      const todos = (Array.isArray(params.todos) ? params.todos : []) as TodoItem[];
      const active = todos.filter(t => t.status === 'in_progress').length;
      if (active > 1) {
        return fail(`${active} items are in_progress; keep exactly one in progress at a time and resend the list.`);
      }
      list.set(todos);
      const open = list.open().length;
      const tail = todos.length === 0
        ? 'Task list cleared.'
        : open === 0
          ? 'All items completed.'
          : `${open} item${open === 1 ? '' : 's'} left.`;
      return ok(`${list.render()}\n\n${tail}`);
    },
  };
}
