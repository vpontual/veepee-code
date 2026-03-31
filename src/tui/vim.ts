/**
 * Minimal vim mode for the input editor.
 * Supports INSERT and NORMAL modes with basic motions and operators.
 */

export type VimMode = 'insert' | 'normal';

export interface VimState {
  mode: VimMode;
  /** Pending count prefix (e.g., "3" in "3w") */
  count: number;
  /** Pending operator (e.g., "d" in "dw") */
  pendingOp: string | null;
}

export interface InputState {
  text: string;
  cursor: number;
}

export function createVimState(): VimState {
  return { mode: 'insert', count: 0, pendingOp: null };
}

/** Process a keypress in vim mode. Returns new input state and whether the key was consumed. */
export function processVimKey(
  key: string,
  vim: VimState,
  input: InputState,
): { input: InputState; vim: VimState; consumed: boolean; action?: 'submit' | 'history-prev' | 'history-next' } {
  // In insert mode, only Escape switches to normal mode
  if (vim.mode === 'insert') {
    if (key === '\x1b') {
      // Move cursor back one (vim behavior)
      const newCursor = Math.max(0, input.cursor - 1);
      return {
        input: { ...input, cursor: newCursor },
        vim: { ...vim, mode: 'normal', count: 0, pendingOp: null },
        consumed: true,
      };
    }
    return { input, vim, consumed: false };
  }

  // Normal mode
  const count = vim.count || 1;

  // Digit accumulation (1-9 start count, 0 is beginning-of-line)
  if (key >= '1' && key <= '9') {
    return { input, vim: { ...vim, count: vim.count * 10 + parseInt(key) }, consumed: true };
  }
  if (key === '0' && vim.count > 0) {
    return { input, vim: { ...vim, count: vim.count * 10 }, consumed: true };
  }

  const resetVim = { mode: 'normal' as const, count: 0, pendingOp: null };

  switch (key) {
    // Mode switches
    case 'i':
      return { input, vim: { ...resetVim, mode: 'insert' }, consumed: true };
    case 'a':
      return {
        input: { ...input, cursor: Math.min(input.text.length, input.cursor + 1) },
        vim: { ...resetVim, mode: 'insert' },
        consumed: true,
      };
    case 'I':
      return { input: { ...input, cursor: 0 }, vim: { ...resetVim, mode: 'insert' }, consumed: true };
    case 'A':
      return { input: { ...input, cursor: input.text.length }, vim: { ...resetVim, mode: 'insert' }, consumed: true };

    // Motions
    case 'h':
      return { input: { ...input, cursor: Math.max(0, input.cursor - count) }, vim: resetVim, consumed: true };
    case 'l':
      return { input: { ...input, cursor: Math.min(input.text.length - 1, input.cursor + count) }, vim: resetVim, consumed: true };
    case '0':
      return { input: { ...input, cursor: 0 }, vim: resetVim, consumed: true };
    case '$':
      return { input: { ...input, cursor: Math.max(0, input.text.length - 1) }, vim: resetVim, consumed: true };
    case 'w': {
      let pos = input.cursor;
      for (let i = 0; i < count; i++) {
        // Skip current word
        while (pos < input.text.length && /\w/.test(input.text[pos])) pos++;
        // Skip whitespace
        while (pos < input.text.length && /\s/.test(input.text[pos])) pos++;
      }
      if (vim.pendingOp === 'd') {
        const newText = input.text.slice(0, input.cursor) + input.text.slice(pos);
        return { input: { text: newText, cursor: input.cursor }, vim: resetVim, consumed: true };
      }
      return { input: { ...input, cursor: pos }, vim: resetVim, consumed: true };
    }
    case 'b': {
      let pos = input.cursor;
      for (let i = 0; i < count; i++) {
        if (pos > 0) pos--;
        while (pos > 0 && /\s/.test(input.text[pos])) pos--;
        while (pos > 0 && /\w/.test(input.text[pos - 1])) pos--;
      }
      if (vim.pendingOp === 'd') {
        const newText = input.text.slice(0, pos) + input.text.slice(input.cursor);
        return { input: { text: newText, cursor: pos }, vim: resetVim, consumed: true };
      }
      return { input: { ...input, cursor: pos }, vim: resetVim, consumed: true };
    }
    case 'e': {
      let pos = input.cursor;
      for (let i = 0; i < count; i++) {
        if (pos < input.text.length - 1) pos++;
        while (pos < input.text.length - 1 && /\s/.test(input.text[pos])) pos++;
        while (pos < input.text.length - 1 && /\w/.test(input.text[pos + 1])) pos++;
      }
      return { input: { ...input, cursor: pos }, vim: resetVim, consumed: true };
    }

    // Operators
    case 'd':
      if (vim.pendingOp === 'd') {
        // dd — delete entire line
        return { input: { text: '', cursor: 0 }, vim: resetVim, consumed: true };
      }
      return { input, vim: { ...vim, pendingOp: 'd' }, consumed: true };

    case 'x': {
      // Delete character under cursor
      const delCount = Math.min(count, input.text.length - input.cursor);
      const newText = input.text.slice(0, input.cursor) + input.text.slice(input.cursor + delCount);
      const newCursor = Math.min(input.cursor, Math.max(0, newText.length - 1));
      return { input: { text: newText, cursor: newCursor }, vim: resetVim, consumed: true };
    }

    case 'c':
      if (vim.pendingOp === 'c') {
        // cc — clear line and enter insert
        return { input: { text: '', cursor: 0 }, vim: { ...resetVim, mode: 'insert' }, consumed: true };
      }
      return { input, vim: { ...vim, pendingOp: 'c' }, consumed: true };

    // History
    case 'k':
      return { input, vim: resetVim, consumed: true, action: 'history-prev' };
    case 'j':
      return { input, vim: resetVim, consumed: true, action: 'history-next' };

    // Submit
    case '\r':
    case '\n':
      return { input, vim: { ...resetVim, mode: 'insert' }, consumed: true, action: 'submit' };

    // Escape resets pending state
    case '\x1b':
      return { input, vim: resetVim, consumed: true };

    default:
      return { input, vim: resetVim, consumed: true };
  }
}
