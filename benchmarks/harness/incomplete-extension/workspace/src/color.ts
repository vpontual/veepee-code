import type { Level } from './levels.js';

/** SGR codes, wrapped in a marker the tests can read without ANSI escapes. */
const CODES: Record<Level, number> = {
  info: 36,
  warn: 33,
  error: 31,
};

export function colorize(level: Level, text: string): string {
  return `<c${CODES[level]}>${text}</c>`;
}
