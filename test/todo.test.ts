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

  it('shows nothing to the model when there is no list', () => {
    expect(new TodoList().contextBlock()).toBe('');
  });
});

describe('todo_write is lenient with how models write the list', () => {
  it("accepts gemma's shape (description + 'todo'/'doing' statuses)", async () => {
    const list = new TodoList();
    const r = await buildTodoTool(list).execute({ todos: [
      { description: 'Create src/sub.js', status: 'doing' },
      { description: 'Write tests', status: 'todo' },
    ] });
    expect(r.success).toBe(true);
    expect(list.all()).toEqual([
      { content: 'Create src/sub.js', status: 'in_progress' },
      { content: 'Write tests', status: 'pending' },
    ]);
  });

  it('keeps the first in-progress item and demotes the rest, instead of failing', async () => {
    const list = new TodoList();
    const r = await buildTodoTool(list).execute({ todos: [
      { content: 'a', status: 'in_progress' }, { content: 'b', status: 'in_progress' },
    ] });
    expect(r.success).toBe(true);
    expect(list.all().map(t => t.status)).toEqual(['in_progress', 'pending']);
  });

  it('answers an unchanged resend with "no change — do the step now"', async () => {
    const list = new TodoList();
    const tool = buildTodoTool(list);
    const todos = [{ content: 'Fix the bug', status: 'in_progress' }, { content: 'Run tests', status: 'pending' }];
    await tool.execute({ todos });
    const again = await tool.execute({ todos });
    expect(again.output).toContain('No change');
    expect(again.output).toContain('Do "Fix the bug" now');
  });
});
