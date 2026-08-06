import type { Level } from './levels.js';

/** Fixed-width tag, so log lines stay aligned in a terminal. */
export function prefix(level: Level): string {
  switch (level) {
    case 'info':
      return '[INFO ]';
    case 'warn':
      return '[WARN ]';
    case 'error':
      return '[ERROR]';
  }
}
