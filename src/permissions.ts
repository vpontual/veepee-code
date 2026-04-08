import { writeFile, readFile, mkdir } from 'fs/promises';
import { resolve, isAbsolute, relative } from 'path';
import { existsSync } from 'fs';

export type PermissionDecision = 'allow' | 'allow_always' | 'deny';

// Prompt handler — can be replaced by TUI's promptPermission
type PromptHandler = (toolName: string, args: Record<string, unknown>, reason?: string) => Promise<string>;

export class PermissionManager {
  private alwaysAllowed = new Set<string>();
  private sessionAllowed = new Set<string>();
  private projectAllowed = new Set<string>(); // tool:project pairs (e.g., "write_file:/home/user/myproject")
  private configPath: string;
  private promptHandler: PromptHandler | null = null;

  // Tools considered safe and auto-allowed (read-only operations)
  private static SAFE_TOOLS = new Set([
    'read_file',
    'list_files',
    'glob',
    'grep',
    'git',
    'weather',
    'system_info',
    'news',
  ]);

  // Dangerous args patterns that should always prompt
  private static DANGEROUS_PATTERNS: Array<{ tool: string; check: (args: Record<string, unknown>) => boolean; reason: string }> = [
    { tool: 'bash', check: (a) => /\brm\s+-rf?\b/.test(String(a.command || '')), reason: 'destructive delete' },
    { tool: 'bash', check: (a) => /\bgit\s+push\b.*--force/.test(String(a.command || '')), reason: 'force push' },
    { tool: 'bash', check: (a) => /\bgit\s+reset\s+--hard/.test(String(a.command || '')), reason: 'hard reset' },
    { tool: 'bash', check: (a) => /\bdocker\s+(rm|rmi|system\s+prune)/.test(String(a.command || '')), reason: 'docker cleanup' },
    { tool: 'git', check: (a) => /push\s+.*--force/.test(String(a.args || '')), reason: 'force push' },
    { tool: 'git', check: (a) => /reset\s+--hard/.test(String(a.args || '')), reason: 'hard reset' },
  ];

  constructor() {
    this.configPath = resolve(process.env.HOME || '~', '.veepee-code', 'permissions.json');
    this.loadPersisted();
  }

  /** Set a custom prompt handler (used by TUI) */
  setPromptHandler(handler: PromptHandler): void {
    this.promptHandler = handler;
  }

  /** For backwards compat — unused with TUI but needed for API mode */
  setReadline(_rl: unknown): void {
    // no-op when TUI is handling prompts
  }

  /** Check if a tool call is allowed, prompting the user if needed */
  async check(toolName: string, args: Record<string, unknown>): Promise<PermissionDecision> {
    const dangerous = PermissionManager.DANGEROUS_PATTERNS.find(
      p => p.tool === toolName && p.check(args)
    );
    if (dangerous) {
      return this.prompt(toolName, args, dangerous.reason);
    }

    if (PermissionManager.SAFE_TOOLS.has(toolName)) {
      return 'allow';
    }

    if (this.alwaysAllowed.has(toolName) || this.sessionAllowed.has(toolName)) {
      return 'allow';
    }

    // Check project-scoped permission (tool allowed for files in this project)
    const filePathRaw = typeof args.path === 'string' ? args.path
      : typeof args.file === 'string' ? args.file : null;
    if (filePathRaw) {
      const filePath = isAbsolute(filePathRaw) ? filePathRaw : resolve(process.cwd(), filePathRaw);
      for (const entry of this.projectAllowed) {
        const sep = entry.indexOf(':');
        if (sep <= 0) continue;
        const tool = entry.slice(0, sep);
        const projectDir = entry.slice(sep + 1);
        const rel = relative(projectDir, filePath);
        const inProject = rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
        if (tool === toolName && inProject) {
          return 'allow';
        }
      }
    }

    return this.prompt(toolName, args);
  }

  private async prompt(toolName: string, args: Record<string, unknown>, reason?: string): Promise<PermissionDecision> {
    if (!this.promptHandler) {
      return 'allow'; // API mode — no interactive prompt
    }

    const answer = await this.promptHandler(toolName, args, reason);
    const choice = answer.trim().toLowerCase();

    if (choice === 'y' || choice === 'yes') {
      return 'allow';
    }

    if (choice === 's' || choice === 'session') {
      this.sessionAllowed.add(toolName);
      return 'allow';
    }

    if (choice === 'a' || choice === 'always') {
      this.alwaysAllowed.add(toolName);
      await this.savePersisted();
      return 'allow_always';
    }

    if (choice === 'p' || choice === 'project') {
      const cwd = process.cwd();
      this.projectAllowed.add(`${toolName}:${cwd}`);
      await this.savePersisted();
      return 'allow';
    }

    return 'deny';
  }

  revoke(toolName: string): boolean {
    const had = this.alwaysAllowed.delete(toolName);
    this.sessionAllowed.delete(toolName);
    if (had) this.savePersisted();
    return had;
  }

  resetSession(): void {
    this.sessionAllowed.clear();
  }

  resetAll(): void {
    this.sessionAllowed.clear();
    this.alwaysAllowed.clear();
    this.savePersisted();
  }

  listPermissions(): { alwaysAllowed: string[]; sessionAllowed: string[]; safeTools: string[] } {
    return {
      alwaysAllowed: Array.from(this.alwaysAllowed).sort(),
      sessionAllowed: Array.from(this.sessionAllowed).sort(),
      safeTools: Array.from(PermissionManager.SAFE_TOOLS).sort(),
    };
  }

  private async loadPersisted(): Promise<void> {
    if (!existsSync(this.configPath)) return;
    try {
      const data = await readFile(this.configPath, 'utf-8');
      const parsed = JSON.parse(data) as { alwaysAllowed?: string[]; projectAllowed?: string[] };
      if (parsed.alwaysAllowed) {
        for (const tool of parsed.alwaysAllowed) {
          this.alwaysAllowed.add(tool);
        }
      }
      if (parsed.projectAllowed) {
        for (const entry of parsed.projectAllowed) {
          this.projectAllowed.add(entry);
        }
      }
    } catch {
      // Ignore corrupt file
    }
  }

  private async savePersisted(): Promise<void> {
    try {
      const dir = resolve(this.configPath, '..');
      await mkdir(dir, { recursive: true });
      await writeFile(this.configPath, JSON.stringify({
        alwaysAllowed: Array.from(this.alwaysAllowed).sort(),
        projectAllowed: Array.from(this.projectAllowed).sort(),
      }, null, 2));
    } catch {
      // Non-critical failure
    }
  }
}
