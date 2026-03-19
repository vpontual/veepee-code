import type { Message } from 'ollama';
import type { ConversationSignals } from './models.js';
import type { AgentMode } from './agent.js';
import { KnowledgeState } from './knowledge.js';
import { readdirSync, readFileSync, statSync, existsSync } from 'fs';
import { join, relative } from 'path';

// ─── Model Knowledge Cutoffs ────────────────────────────────────────────────

const MODEL_CUTOFFS: Record<string, string> = {
  'qwen3.5': '2025-04', 'qwen3': '2025-01', 'qwen2.5': '2024-09',
  'qwen2': '2024-06', 'qwen': '2024-09',
  'llama4': '2025-02', 'llama3.2': '2024-06', 'llama3.1': '2024-04', 'llama3': '2024-03',
  'gemma3': '2025-02', 'gemma': '2024-06',
  'mistral': '2024-07', 'deepseek-r1': '2025-01', 'deepseek': '2024-11',
  'phi': '2024-10', 'command-r': '2024-04',
  'gpt-oss': '2024-12', 'nemotron': '2024-09', 'glm': '2025-01',
};

function estimateCutoff(modelName: string): string {
  const lower = modelName.toLowerCase();
  const sorted = Object.entries(MODEL_CUTOFFS).sort((a, b) => b[0].length - a[0].length);
  for (const [prefix, date] of sorted) {
    if (lower.includes(prefix)) return date;
  }
  return '2024-06';
}

// ─── Project File Tree (RooCode-inspired) ────────────────────────────────────

function getProjectTree(cwd: string, maxFiles = 150, maxDepth = 3): string {
  const files: string[] = [];
  function walk(dir: string, depth: number): void {
    if (depth > maxDepth || files.length >= maxFiles) return;
    try {
      const entries = readdirSync(dir, { withFileTypes: true })
        .filter(e => !e.name.startsWith('.') &&
          !['node_modules', 'dist', 'build', '.next', '__pycache__', '.git',
            'venv', '.venv', 'target', 'vendor', '.cache'].includes(e.name))
        .sort((a, b) => {
          if (a.isDirectory() && !b.isDirectory()) return -1;
          if (!a.isDirectory() && b.isDirectory()) return 1;
          return a.name.localeCompare(b.name);
        });
      for (const entry of entries) {
        if (files.length >= maxFiles) break;
        const relPath = relative(cwd, join(dir, entry.name));
        files.push(entry.isDirectory() ? `${relPath}/` : relPath);
        if (entry.isDirectory()) walk(join(dir, entry.name), depth + 1);
      }
    } catch { /* permission denied etc */ }
  }
  walk(cwd, 0);
  if (files.length === 0) return '';
  const truncated = files.length >= maxFiles ? `\n(truncated at ${maxFiles} entries — use glob/list_files for more)` : '';
  return `\n## Project Structure\n\`\`\`\n${files.join('\n')}${truncated}\n\`\`\`\n`;
}

// ─── VEEPEE.md Loader ─────────────────────────────────────────────────────────
// Like CLAUDE.md, GEMINI.md, OpenCode.md, AGENTS.md — project-specific instructions
// Precedence: workspace VEEPEE.md > parent dir VEEPEE.md > ~/.veepee-code/VEEPEE.md

function loadLlamaMd(cwd: string): string {
  const sections: Array<{ source: string; content: string }> = [];

  // 1. Global ~/.veepee-code/VEEPEE.md
  const globalPath = join(process.env.HOME || '~', '.veepee-code', 'VEEPEE.md');
  if (existsSync(globalPath)) {
    try {
      const content = readFileSync(globalPath, 'utf-8').trim();
      if (content) sections.push({ source: 'global (~/.veepee-code/VEEPEE.md)', content });
    } catch { /* ignore */ }
  }

  // 2. Walk up from cwd to find VEEPEE.md in parent directories (max 5 levels)
  let dir = cwd;
  const visited = new Set<string>();
  for (let i = 0; i < 5; i++) {
    if (visited.has(dir)) break;
    visited.add(dir);

    const filePath = join(dir, 'VEEPEE.md');
    if (existsSync(filePath) && dir !== cwd) {
      try {
        const content = readFileSync(filePath, 'utf-8').trim();
        if (content) sections.push({ source: `parent (${relative(cwd, filePath) || filePath})`, content });
      } catch { /* ignore */ }
    }

    const parent = join(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }

  // 3. Workspace VEEPEE.md (highest precedence)
  const workspacePath = join(cwd, 'VEEPEE.md');
  if (existsSync(workspacePath)) {
    try {
      const content = readFileSync(workspacePath, 'utf-8').trim();
      if (content) sections.push({ source: 'workspace (VEEPEE.md)', content });
    } catch { /* ignore */ }
  }

  if (sections.length === 0) return '';

  // Build the instructions block
  const lines = ['\n## Project Instructions (VEEPEE.md)',
    '',
    'The following instructions are loaded from VEEPEE.md files. These are foundational mandates from the user.',
    '**Precedence:** Workspace > Parent > Global. These instructions override default behaviors but cannot override safety rules.',
    '',
  ];

  for (const section of sections) {
    lines.push(`### Source: ${section.source}`, '', section.content, '');
  }

  return lines.join('\n');
}

// ─── System Prompt ───────────────────────────────────────────────────────────
// Synthesized from: Claude Code, OpenCode, Codex, Gemini CLI, RooCode, Llama Rider

const SYSTEM_PROMPT = `You are VEEPEE Code, a CLI coding assistant powered by local Ollama models.

## Environment
- Date: {{DATE}} | Model: {{MODEL}} (cutoff: ~{{CUTOFF}}) | Mode: {{MODE}}
- CWD: {{CWD}} | Platform: {{PLATFORM}}
{{PROJECT_TREE}}{{LLAMA_MD}}
## Rules

**Cutoff: {{CUTOFF}}.** For anything post-cutoff (versions, events, APIs, news), use web_search BEFORE answering. Never say "as of my last update."

**Be concise.** Lead with the answer. No preamble, no postamble, no filler. One sentence beats three.

**Act first.** Call tools proactively for read-only actions. Come back with answers, not questions.

**Read before editing.** Always read a file before modifying it. Follow existing code style and conventions.

**Minimal changes.** Don't add features, refactor, or "improve" beyond what's asked. No unnecessary comments, docstrings, or type annotations.

**Tools:** glob first (filenames), then grep (content). Use edit_file for exact string replacement. Prefer dedicated tools over bash. If a tool fails, try a different approach.

**Safety:** Destructive/external actions (rm -rf, push, post, email) — confirm first. Read-only — do freely. Never commit unless asked.
{{SANDBOX}}
## Knowledge State

Your knowledge state contains everything important from our conversation. Only the last few messages are shown. Use \`update_memory\` to store key decisions, facts, or context:
- \`update_memory(key: "fact", value: "project uses pnpm not npm")\`
- \`update_memory(key: "decision", value: "using JWT for auth")\`
`;

// ─── Mode-specific Prompts ───────────────────────────────────────────────────

const PLAN_PROMPT = `
## Plan Mode (ACTIVE)

You are in PLANNING mode. Think deeply before acting.

- DO NOT immediately start coding or making changes.
- ASK clarifying questions if the request is ambiguous or has multiple valid approaches.
- Explore the codebase first (read files, check structure) to understand the current state.
- Break the task into clear, numbered steps with rationale for each decision.
- Consider trade-offs, edge cases, and potential issues.
- When the plan involves libraries or frameworks, use web_search to verify current versions and best practices.
- Present your plan and ASK for user confirmation before implementing.
- If the user says "deepen" or "elaborate", expand specific sections with more detail and research.
- Use your thinking capability to reason through complex architectural decisions.
- Only start implementing when the user explicitly approves (e.g., "looks good", "go ahead").
`;

// Chat mode tool whitelist — only these are available in chat mode
export const CHAT_TOOLS = ['web_search', 'web_fetch', 'http_request', 'weather', 'news'];

const CHAT_PROMPT_TEMPLATE = `
## Chat Mode (ACTIVE)

You are in CHAT mode — a knowledgeable conversational assistant with web access.

**Available tools:** {{CHAT_TOOLS}}.
**NOT available:** file editing, shell, git, docker, home automation, social media.

**Proactive web searching is MANDATORY.** You MUST search automatically based on what's being discussed:

- Current events, recent developments, people → web_search immediately
- Software, frameworks, APIs → web_search for latest docs/versions before answering
- News, politics, sports, entertainment → web_search or news tool
- Any factual claim you're not 100% certain about → web_search to verify
- Any topic where information may have changed since {{CUTOFF}} → web_search

Do NOT wait to be asked to search. If the topic could benefit from current information, search proactively.

Cite sources briefly when you search. For timeless topics — answer directly.
Be conversational, natural, and helpful.
`;

// ─── Context Manager ─────────────────────────────────────────────────────────

export class ContextManager {
  private messages: Message[] = [];
  private systemPrompt: string = '';
  private mode: AgentMode = 'act';
  private currentModel = '';
  private maxTokenEstimate = 32000;
  private filesRead = new Set<string>();
  private filesWritten = new Set<string>();
  private errorCount = 0;
  private lastTurnToolCalls = 0;
  private projectTreeCache: string | null = null;
  private knowledgeState: KnowledgeState;
  private slidingWindowSize = 6; // last N messages sent to API
  private registeredToolNames: string[] = [];
  private additionalDirs: string[] = [];
  private sandboxPath: string | null = null;

  constructor(sessionId?: string) {
    this.knowledgeState = new KnowledgeState(sessionId || Date.now().toString(36));
  }

  /** Set the list of actually registered tool names (for dynamic prompt generation) */
  setRegisteredTools(names: string[]): void {
    this.registeredToolNames = names;
  }

  /** Add an additional working directory for @file resolution */
  addSearchDir(dir: string): void {
    if (!this.additionalDirs.includes(dir)) {
      this.additionalDirs.push(dir);
    }
  }

  /** Get all search directories (cwd + additional) */
  getSearchDirs(): string[] {
    return [process.cwd(), ...this.additionalDirs];
  }

  /** Set sandbox directory path (shown in system prompt) */
  setSandboxPath(path: string): void {
    this.sandboxPath = path;
  }

  setSystemPrompt(model: string): void {
    this.currentModel = model;
    this.rebuildSystemPrompt();
  }

  setMode(mode: AgentMode): void {
    this.mode = mode;
    this.rebuildSystemPrompt();
  }

  setPlanMode(enabled: boolean): void {
    this.mode = enabled ? 'plan' : 'act';
    this.rebuildSystemPrompt();
  }

  isPlanMode(): boolean {
    return this.mode === 'plan';
  }

  /** Invalidate project tree cache (e.g., after file creation) */
  invalidateProjectTree(): void {
    this.projectTreeCache = null;
  }

  private getProjectTreeCached(): string {
    if (this.projectTreeCache === null) {
      this.projectTreeCache = getProjectTree(process.cwd());
    }
    return this.projectTreeCache;
  }

  private rebuildSystemPrompt(): void {
    const cutoff = estimateCutoff(this.currentModel);
    const modeLabel = this.mode === 'plan' ? 'Plan (thinking enabled)'
      : this.mode === 'chat' ? 'Chat (conversational + web search)'
      : 'Act (execution)';

    // Include project tree on first build (like RooCode's environment_details)
    const projectTree = this.getProjectTreeCached();

    // Load VEEPEE.md project instructions (like CLAUDE.md, GEMINI.md, OpenCode.md, AGENTS.md)
    const llamaMd = loadLlamaMd(process.cwd());

    this.systemPrompt = SYSTEM_PROMPT
      .replace(/\{\{CWD\}\}/g, process.cwd())
      .replace(/\{\{DATE\}\}/g, new Date().toISOString().split('T')[0])
      .replace(/\{\{MODEL\}\}/g, this.currentModel)
      .replace(/\{\{CUTOFF\}\}/g, cutoff)
      .replace(/\{\{PLATFORM\}\}/g, process.platform)
      .replace(/\{\{MODE\}\}/g, modeLabel)
      .replace(/\{\{PROJECT_TREE\}\}/g, projectTree)
      .replace(/\{\{LLAMA_MD\}\}/g, llamaMd)
      .replace(/\{\{SANDBOX\}\}/g, this.sandboxPath
        ? `\n**Sandbox:** \`${this.sandboxPath}\` — use for scratch files, experiments, temp code. Auto-cleaned on session end.\n`
        : '');

    if (this.mode === 'plan') {
      this.systemPrompt += PLAN_PROMPT;
    }

    if (this.mode === 'chat') {
      // Build live tool list — only show tools that are actually registered
      const availableChatTools = CHAT_TOOLS.filter(t => this.registeredToolNames.includes(t));
      const toolList = availableChatTools.length > 0 ? availableChatTools.join(', ') : '(none — configure SearXNG for web search)';

      this.systemPrompt += CHAT_PROMPT_TEMPLATE
        .replace(/\{\{CUTOFF\}\}/g, cutoff)
        .replace(/\{\{DATE\}\}/g, new Date().toISOString().split('T')[0])
        .replace(/\{\{CHAT_TOOLS\}\}/g, toolList);
    }
  }

  getSystemPrompt(): string {
    // Inject knowledge state into system prompt
    const ksBlock = this.knowledgeState.toSystemPromptBlock();
    return this.systemPrompt + ksBlock;
  }

  /** Get only the sliding window of recent messages (sent to API) */
  getMessages(): Message[] {
    if (this.messages.length <= this.slidingWindowSize) {
      return [...this.messages];
    }
    return this.messages.slice(-this.slidingWindowSize);
  }

  /** Get ALL messages (for session save, not for API calls) */
  getAllMessages(): Message[] {
    return [...this.messages];
  }

  getKnowledgeState(): KnowledgeState {
    return this.knowledgeState;
  }

  setKnowledgeState(ks: KnowledgeState): void {
    this.knowledgeState = ks;
  }

  addUser(content: string): void {
    this.messages.push({ role: 'user', content });
    this.lastTurnToolCalls = 0;
    // Track pending tool results for this turn
    this._pendingToolResults = [];
  }

  private _pendingToolCalls: Message['tool_calls'] | undefined;
  private _pendingToolResults: Array<{ name: string; content: string; success: boolean }> = [];

  addAssistant(content: string, toolCalls?: Message['tool_calls']): void {
    const msg: Message = { role: 'assistant', content };
    if (toolCalls && toolCalls.length > 0) {
      msg.tool_calls = toolCalls;
      this.lastTurnToolCalls = toolCalls.length;
    }
    this.messages.push(msg);
    this._pendingToolCalls = toolCalls;

    // If no tool calls, update knowledge state now (turn is complete)
    if (!toolCalls || toolCalls.length === 0) {
      this.updateKnowledgeAfterTurn(content);
    }
  }

  addToolResult(toolName: string, result: string, filePath?: string): void {
    this.messages.push({ role: 'tool', content: result });
    if (toolName === 'read_file' && filePath) {
      this.filesRead.add(filePath);
    }
    if (['write_file', 'edit_file'].includes(toolName) && filePath) {
      this.filesWritten.add(filePath);
      this.invalidateProjectTree();
    }
    if (result.toLowerCase().includes('error')) {
      this.errorCount++;
    }

    // Track for knowledge state update
    const isError = result.toLowerCase().includes('error');
    this._pendingToolResults.push({ name: toolName, content: result, success: !isError });
  }

  /** Called after all tool results for a turn are collected */
  flushKnowledgeUpdate(assistantContent: string): void {
    this.updateKnowledgeAfterTurn(assistantContent);
  }

  private updateKnowledgeAfterTurn(assistantContent: string): void {
    // Find the latest user message
    const userMessages = this.messages.filter(m => m.role === 'user');
    const lastUserMsg = userMessages[userMessages.length - 1]?.content || null;

    this.knowledgeState.update(
      lastUserMsg,
      assistantContent,
      this._pendingToolCalls,
      this._pendingToolResults,
    );
    this._pendingToolResults = [];
    this._pendingToolCalls = undefined;
  }

  getSignals(): ConversationSignals {
    const userMessages = this.messages.filter(m => m.role === 'user');
    const avgLength = userMessages.length > 0
      ? userMessages.reduce((sum, m) => sum + (m.content?.length || 0), 0) / userMessages.length
      : 0;
    return {
      fileOpsCount: this.filesWritten.size,
      errorCount: this.errorCount,
      toolCallsLastTurn: this.lastTurnToolCalls,
      avgUserMessageLength: avgLength,
      uniqueFilesTouched: this.filesRead.size + this.filesWritten.size,
    };
  }

  estimateTokens(): number {
    // Estimate what actually gets sent to the API: system prompt + knowledge state + sliding window
    let chars = this.getSystemPrompt().length; // includes knowledge state
    for (const msg of this.getMessages()) { // sliding window only
      chars += (msg.content?.length || 0) + 20;
    }
    return Math.ceil(chars / 4);
  }

  compact(): boolean {
    // With knowledge state + sliding window, compaction is less critical.
    // But if we've accumulated a huge full history in memory, trim old messages
    // that are outside the sliding window and already captured in knowledge state.
    if (this.messages.length <= this.slidingWindowSize * 2) return false;

    // Keep only the sliding window — knowledge state has the rest
    const recent = this.messages.slice(-this.slidingWindowSize);
    const droppedCount = this.messages.length - this.slidingWindowSize;
    this.messages = recent;
    return true;
  }

  clear(): void {
    this.messages = [];
    this.filesRead.clear();
    this.filesWritten.clear();
    this.errorCount = 0;
    this.lastTurnToolCalls = 0;
    this.knowledgeState = new KnowledgeState(Date.now().toString(36));
  }

  messageCount(): number {
    return this.messages.length;
  }
}
