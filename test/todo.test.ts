import { describe, it, expect } from 'vitest';
import { TodoList, buildTodoTool } from '../src/todo.js';

describe('todo_write', () => {
  it('replaces the list, renders it, and counts what is left', async () => {
    const list = new TodoList();
    const tool = buildTodoTool(list);
    const r = await tool.execute({ todos: [
      { content: 'Read range.ts', status: 'completed' },
      { content: 'Fix the off-by-one', status: 'in_progress' },
      { content: 'Run the tests', status: 'pending' },
    ] });
    expect(r.success).toBe(true);
    expect(r.output).toBe('[x] Read range.ts\n[~] Fix the off-by-one\n[ ] Run the tests\n\n2 items left.');
    expect(list.open().map(t => t.content)).toEqual(['Fix the off-by-one', 'Run the tests']);
    expect(list.contextBlock()).toContain('Your task list (1/3 done');
  });

  it('refuses two items in progress', async () => {
    const list = new TodoList();
    const r = await buildTodoTool(list).execute({ todos: [
      { content: 'a', status: 'in_progress' }, { content: 'b', status: 'in_progress' },
    ] });
    expect(r.success).toBe(false);
    expect(list.all()).toEqual([]);
  });

  it('shows nothing to the model when there is no list', () => {
    expect(new TodoList().contextBlock()).toBe('');
  });
});
