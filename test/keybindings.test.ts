import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolveKey, REBINDABLE_ACTIONS, getAllBindings, type KeyAction } from '../src/tui/keybindings.js';

/**
 * keybindings.ts was DEAD CODE. Nothing in the codebase imported it, so the
 * documented ~/.veepee-code/keybindings.json override file — parsed, merged
 * over the defaults, described by describeKey — had never changed a single
 * keystroke. handleKey compared raw strings instead, and a comment in it
 * admitted the map was "kept in sync ... when wired in Phase 1".
 */
const tui = readFileSync(new URL('../src/tui/index.ts', import.meta.url), 'utf-8');

describe('the binding map is actually wired', () => {
  it('is imported by the TUI', () => {
    expect(tui).toMatch(/import \{ resolveKey, REBINDABLE_ACTIONS \} from '\.\/keybindings\.js'/);
  });

  it('is consulted in handleKey', () => {
    expect(tui).toMatch(/const action = resolveKey\(key\);/);
    expect(tui).toMatch(/REBINDABLE_ACTIONS\.has\(action\)/);
  });

  it('has no raw handler left for an action it claims to own', () => {
    // Each of these used to be compared raw further down, shadowing the map.
    expect(tui).not.toMatch(/if \(key === '\\x19'\)/);   // Ctrl+Y  copyResponse
    expect(tui).not.toMatch(/if \(key === '\\x0c'\)/);   // Ctrl+L  clearScreen
    expect(tui).not.toMatch(/key === '\\x1b\[1;5H'/);    // Ctrl+Home scrollTop
    expect(tui).not.toMatch(/key === '\\x1b\[1;5F'/);    // Ctrl+End  scrollBottom
  });

  it('still clears the agent context on clearScreen, not just the screen', () => {
    // The raw Ctrl+L handler called clearHandler as well as clearing messages.
    // Losing that would have made the key look like it worked.
    expect(tui).toMatch(/case 'clearScreen':[\s\S]{0,400}this\.clearHandler\?\.\(\)/);
  });
});

describe('resolveKey', () => {
  it('maps Shift+Tab to the posture cycle', () => {
    expect(resolveKey('\x1b[Z')).toBe('cyclePosture');
  });

  it('maps the scroll keys', () => {
    expect(resolveKey('\x1b[5~')).toBe('scrollPageUp');
    expect(resolveKey('\x1b[6~')).toBe('scrollPageDown');
    expect(resolveKey('\x1b[1;5H')).toBe('scrollTop');
    expect(resolveKey('\x1b[1;5F')).toBe('scrollBottom');
  });

  it('returns null for an unbound key', () => {
    expect(resolveKey('\x1b[99~')).toBeNull();
  });
});

describe('REBINDABLE_ACTIONS is an honest boundary', () => {
  it('every rebindable action is dispatched in handleKey', () => {
    for (const action of REBINDABLE_ACTIONS) {
      expect(tui, `${action} is rebindable but has no case`).toContain(`case '${action}':`);
    }
  });

  it('every rebindable action has at least one default binding', () => {
    const bound = new Set(Object.values(getAllBindings()) as KeyAction[]);
    for (const action of REBINDABLE_ACTIONS) {
      expect(bound, `${action} is rebindable but unbound`).toContain(action);
    }
  });

  it('excludes the contextual actions', () => {
    // An arrow means history at the prompt, navigation in a menu, and scroll in
    // a trackpad burst. Those cannot be resolved from the key alone.
    for (const contextual of ['submit', 'historyPrev', 'cursorLeft', 'deleteBack', 'tab']) {
      expect(REBINDABLE_ACTIONS.has(contextual as KeyAction)).toBe(false);
    }
  });
});
