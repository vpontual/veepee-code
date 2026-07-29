import { readFileSync, existsSync, realpathSync } from 'fs';
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
  // A trailing slash means "this directory and everything under it"; without
  // the `(?:/.*)?` the regex ended at the slash and matched nothing at all, so
  // a gitignore-style `secrets/` line silently protected nothing.
  if (pattern.endsWith('/')) {
    return new RegExp(`(?:^|/)${re.replace(/\/$/, '')}(?:/.*)?$`);
  }
  // A pattern with no slash and no wildcard names an entry — match the entry
  // itself AND anything beneath it, so `node_modules` covers its contents.
  if (!pattern.includes('/') && !pattern.includes('*') && !pattern.includes('?')) {
    return new RegExp(`(?:^|/)${re}(?:/.*)?$`);
  }
  return new RegExp(`(?:^|/)${re}$`);
}

/** Ignore-file names, loaded in order at each level. Later files win on
 *  conflicts because patterns are applied in order and negations override. */
export const IGNORE_FILENAMES = ['.agentignore', '.veepeignore'] as const;

export class IgnoreManager {
  private patterns: Array<{ pattern: string; regex: RegExp; negated: boolean }> = [];

  constructor(cwd: string) {
    // Load default protected patterns
    for (const p of DEFAULT_PATTERNS) {
      this.addPattern(p);
    }

    // `.agentignore` is the cross-agent convention (being standardised
    // alongside AGENTS.md); `.veepeignore` stays supported for existing
    // setups. Unlike instruction files these are ADDITIVE — a repo that has
    // both means "block everything either one names", so both are loaded
    // rather than first-wins. `.veepeignore` is loaded last at each level so
    // its negations (`!pattern`) can override the shared file.
    for (const dir of [join(os.homedir(), '.veepee-code'), cwd]) {
      for (const name of IGNORE_FILENAMES) {
        this.loadFile(join(dir, name));
      }
    }
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
    // Test BOTH the given path and its symlink target. resolve() only
    // normalises `..`; it does not follow links, so `config/local.json`
    // pointing at `../../.env` sailed past the `**/.env` rule and handed the
    // model the credentials it was supposed to protect.
    const candidates = new Set<string>();
    const direct = resolve(filePath);
    candidates.add(direct.replace(/\\/g, '/'));
    try {
      candidates.add(realpathSync(direct).replace(/\\/g, '/'));
    } catch { /* path doesn't exist yet — the direct form is all we have */ }

    let blockedAny: string | null = null;
    for (const candidate of candidates) {
      const r = this.matchPath(candidate);
      if (r) blockedAny = r;
    }
    return blockedAny;
  }

  /** Run the pattern list against one already-normalised absolute path. */
  private matchPath(normalized: string): string | null {

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
