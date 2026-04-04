import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import os from 'os';

/** Read the last N unique shell commands from zsh or bash history */
export function getRecentShellHistory(limit = 20): string[] {
  const home = os.homedir();

  // Try zsh first (most common on macOS/modern Linux), then bash
  const candidates = [
    resolve(home, '.zsh_history'),
    resolve(home, '.bash_history'),
  ];

  for (const histFile of candidates) {
    if (!existsSync(histFile)) continue;
    try {
      const raw = readFileSync(histFile, 'utf-8');
      const lines = raw.split('\n').filter(Boolean);

      const commands = lines
        // Strip zsh extended history format: `: 1234567890:0;command`
        .map(l => (l.startsWith(': ') ? l.replace(/^: \d+:\d+;/, '') : l).trim())
        // Drop empty lines, comments, and history-internal markers
        .filter(l => l && !l.startsWith('#') && l.length > 1)
        // Take a pool larger than needed so deduplication can pick the freshest copies
        .slice(-limit * 4)
        // Deduplicate: keep only the LAST occurrence of each command
        .reduce<string[]>((acc, cmd) => {
          const existing = acc.indexOf(cmd);
          if (existing >= 0) acc.splice(existing, 1);
          acc.push(cmd);
          return acc;
        }, [])
        // Take the most recent N
        .slice(-limit);

      if (commands.length > 0) return commands;
    } catch { /* unreadable — try next */ }
  }

  return [];
}

/** Format shell history as a system prompt block */
export function formatShellHistoryBlock(commands: string[]): string {
  if (commands.length === 0) return '';
  return [
    '\n## Recent Shell Commands',
    '',
    'These commands were recently run in the terminal. Use them as context about what the user is currently working on:',
    '```',
    ...commands,
    '```',
    '',
  ].join('\n');
}
