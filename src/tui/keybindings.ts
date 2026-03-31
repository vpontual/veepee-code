import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

/** Named actions that can be bound to keystrokes */
export type KeyAction =
  | 'submit' | 'newline' | 'abort' | 'quit'
  | 'scrollUp' | 'scrollDown' | 'scrollPageUp' | 'scrollPageDown'
  | 'scrollTop' | 'scrollBottom'
  | 'historyPrev' | 'historyNext'
  | 'cursorLeft' | 'cursorRight' | 'cursorHome' | 'cursorEnd'
  | 'cursorWordLeft' | 'cursorWordRight'
  | 'deleteBack' | 'deleteForward' | 'deleteWord' | 'deleteLine'
  | 'clearScreen' | 'copyResponse' | 'selectUp' | 'selectDown'
  | 'dismiss' | 'tab';

/** Raw key codes to named actions */
export interface KeybindingMap {
  [rawKey: string]: KeyAction;
}

/** Default keybinding configuration */
const DEFAULT_BINDINGS: KeybindingMap = {
  // Submit
  '\r': 'submit',
  '\n': 'submit',

  // Newline (Shift+Enter, Alt+Enter)
  '\x1b\r': 'newline',
  '\x1b\n': 'newline',
  '\x1b[13;2u': 'newline',
  '\x1b[27;2;13~': 'newline',

  // Control
  '\x03': 'abort',       // Ctrl+C
  '\x04': 'quit',        // Ctrl+D
  '\x0c': 'clearScreen', // Ctrl+L
  '\x19': 'copyResponse', // Ctrl+Y
  '\t': 'tab',

  // Scroll
  '\x1b[5~': 'scrollPageUp',   // PgUp
  '\x1b[6~': 'scrollPageDown', // PgDn
  '\x1b[1;5A': 'scrollUp',     // Ctrl+Up
  '\x1b[1;5B': 'scrollDown',   // Ctrl+Down

  // History (arrows handled contextually — these are for when no menu is open)
  '\x1b[A': 'historyPrev',  // Up
  '\x1bOA': 'historyPrev',
  '\x1b[B': 'historyNext',  // Down
  '\x1bOB': 'historyNext',

  // Cursor movement
  '\x1b[D': 'cursorLeft',
  '\x1bOD': 'cursorLeft',
  '\x1b[C': 'cursorRight',
  '\x1bOC': 'cursorRight',
  '\x1b[H': 'cursorHome',
  '\x1bOH': 'cursorHome',
  '\x01': 'cursorHome',    // Ctrl+A
  '\x1b[F': 'cursorEnd',
  '\x1bOF': 'cursorEnd',
  '\x05': 'cursorEnd',     // Ctrl+E
  '\x1bb': 'cursorWordLeft',  // Alt+B
  '\x1bf': 'cursorWordRight', // Alt+F
  '\x1b[1;5D': 'cursorWordLeft',  // Ctrl+Left
  '\x1b[1;5C': 'cursorWordRight', // Ctrl+Right

  // Delete
  '\x7f': 'deleteBack',    // Backspace
  '\b': 'deleteBack',
  '\x1b[3~': 'deleteForward', // Delete
  '\x17': 'deleteWord',     // Ctrl+W
  '\x15': 'deleteLine',     // Ctrl+U
};

let userOverrides: KeybindingMap = {};
let loaded = false;

/** Load user keybinding overrides from config */
function loadUserBindings(): void {
  if (loaded) return;
  loaded = true;

  const configPath = join(process.env.HOME || '~', '.veepee-code', 'keybindings.json');
  if (!existsSync(configPath)) return;

  try {
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, string>;
    // Convert human-readable key names to raw codes
    for (const [key, action] of Object.entries(parsed)) {
      if (typeof action === 'string') {
        userOverrides[key] = action as KeyAction;
      }
    }
  } catch { /* ignore bad config */ }
}

/** Resolve a raw keystroke to a named action */
export function resolveKey(rawKey: string): KeyAction | null {
  loadUserBindings();
  return userOverrides[rawKey] ?? DEFAULT_BINDINGS[rawKey] ?? null;
}

/** Get all bindings (for /keybindings command) */
export function getAllBindings(): KeybindingMap {
  loadUserBindings();
  return { ...DEFAULT_BINDINGS, ...userOverrides };
}

/** Describe a raw key code in human-readable form */
export function describeKey(raw: string): string {
  const map: Record<string, string> = {
    '\r': 'Enter', '\n': 'Enter', '\x03': 'Ctrl+C', '\x04': 'Ctrl+D',
    '\x0c': 'Ctrl+L', '\x19': 'Ctrl+Y', '\t': 'Tab', '\x1b': 'Escape',
    '\x1b[A': 'Up', '\x1b[B': 'Down', '\x1b[C': 'Right', '\x1b[D': 'Left',
    '\x1b[5~': 'PgUp', '\x1b[6~': 'PgDn', '\x7f': 'Backspace',
    '\x01': 'Ctrl+A', '\x05': 'Ctrl+E', '\x17': 'Ctrl+W', '\x15': 'Ctrl+U',
  };
  return map[raw] ?? raw.replace(/\x1b/g, 'Esc');
}
