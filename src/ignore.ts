import { readFileSync, existsSync } from 'fs';
import { resolve, join } from 'path';
import os from 'os';

// Default patterns always blocked — sensitive credentials and keys
const DEFAULT_PATTERNS = [
  '**/.env',
  '**/.env.*',
  '**/secrets.*',
  '**/*.pem',
  '**/*.key',
  '**/*.p12',
  '**/*.pfx',
];

/** Convert a glob pattern to a RegExp */
function globToRegex(pattern: string): RegExp {
  let re = '';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      if (pattern[i + 2] === '/') {
        re += '(?:.+/)?';
        i += 3;
      } else {
        re += '.*';
        i += 2;
      }
    } else if (c === '*') {
      re += '[^/]*';
      i++;
    } else if (c === '?') {
      re += '[^/]';
      i++;
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += '\\' + c;
      i++;
    } else {
      re += c;
      i++;
    }
  }
  return new RegExp(`(?:^|/)${re}$`);
}

export class IgnoreManager {
  private patterns: Array<{ pattern: string; regex: RegExp; negated: boolean }> = [];

  constructor(cwd: string) {
    // Load default protected patterns
    for (const p of DEFAULT_PATTERNS) {
      this.addPattern(p);
    }

    // Load global ~/.veepee-code/.veepeignore
    const globalPath = join(os.homedir(), '.veepee-code', '.veepeignore');
    this.loadFile(globalPath);

    // Load local {cwd}/.veepeignore (project-level overrides)
    const localPath = join(cwd, '.veepeignore');
    this.loadFile(localPath);
  }

  private addPattern(raw: string): void {
    const negated = raw.startsWith('!');
    const pattern = negated ? raw.slice(1) : raw;
    try {
      this.patterns.push({ pattern, regex: globToRegex(pattern), negated });
    } catch {
      // Ignore malformed patterns
    }
  }

  private loadFile(filePath: string): void {
    if (!existsSync(filePath)) return;
    try {
      const lines = readFileSync(filePath, 'utf-8').split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        this.addPattern(trimmed);
      }
    } catch { /* unreadable */ }
  }

  /** Returns the matching pattern if the path is blocked, null if allowed */
  getBlockedReason(filePath: string): string | null {
    const normalized = resolve(filePath).replace(/\\/g, '/');

    let blocked: string | null = null;

    // Process patterns in order — later patterns (including negations) override earlier ones
    for (const { pattern, regex, negated } of this.patterns) {
      if (regex.test(normalized)) {
        if (negated) {
          blocked = null; // explicitly allowed
        } else {
          blocked = pattern;
        }
      }
    }

    return blocked;
  }

  isBlocked(filePath: string): boolean {
    return this.getBlockedReason(filePath) !== null;
  }
}
