import type { Message } from 'ollama';
import type { ConversationSignals } from './models.js';
import type { AgentMode } from './agent.js';
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

// ─── LLAMA.md Loader ─────────────────────────────────────────────────────────
// Like CLAUDE.md, GEMINI.md, OpenCode.md, AGENTS.md — project-specific instructions
// Precedence: workspace LLAMA.md > parent dir LLAMA.md > ~/.llama-code/LLAMA.md

function loadLlamaMd(cwd: string): string {
  const sections: Array<{ source: string; content: string }> = [];

  // 1. Global ~/.llama-code/LLAMA.md
  const globalPath = join(process.env.HOME || '~', '.llama-code', 'LLAMA.md');
  if (existsSync(globalPath)) {
    try {
      const content = readFileSync(globalPath, 'utf-8').trim();
      if (content) sections.push({ source: 'global (~/.llama-code/LLAMA.md)', content });
    } catch { /* ignore */ }
  }

  // 2. Walk up from cwd to find LLAMA.md in parent directories (max 5 levels)
  let dir = cwd;
  const visited = new Set<string>();
  for (let i = 0; i < 5; i++) {
    if (visited.has(dir)) break;
    visited.add(dir);

    const filePath = join(dir, 'LLAMA.md');
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

  // 3. Workspace LLAMA.md (highest precedence)
  const workspacePath = join(cwd, 'LLAMA.md');
  if (existsSync(workspacePath)) {
    try {
      const content = readFileSync(workspacePath, 'utf-8').trim();
      if (content) sections.push({ source: 'workspace (LLAMA.md)', content });
    } catch { /* ignore */ }
  }

  if (sections.length === 0) return '';

  // Build the instructions block
  const lines = ['\n## Project Instructions (LLAMA.md)',
    '',
    'The following instructions are loaded from LLAMA.md files. These are foundational mandates from the user.',
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

const SYSTEM_PROMPT = `You are Llama Code, a CLI coding assistant powered by local Ollama models. You help users with software engineering tasks directly in their terminal.

## Environment
- **Date:** {{DATE}}
- **Model:** {{MODEL}} (knowledge cutoff: ~{{CUTOFF}})
- **Working directory:** {{CWD}}
- **Platform:** {{PLATFORM}}
- **Mode:** {{MODE}}
{{PROJECT_TREE}}{{LLAMA_MD}}
## Knowledge Cutoff — CRITICAL

Your training data cuts off at approximately {{CUTOFF}}. Today is {{DATE}}.

- NEVER present post-cutoff information as fact.
- NEVER say "as of my last update" or "my knowledge cutoff is..." — ALWAYS search first, then answer.
- If the user asks about ANYTHING that may have changed after {{CUTOFF}} — events, software versions, API changes, library docs, news — use web_search BEFORE answering.
- When discussing frameworks, libraries, or APIs: VERIFY the latest version/docs with web_search before giving advice.
- If the user says "today", "this week", "recently", "latest", "current" — that's a signal to search.

## Tone & Output

You MUST be concise. Keep text output to fewer than 4 lines unless the user asks for detail.
- Lead with the answer or action, not the reasoning.
- One-word or one-line answers are ideal when they suffice.
- No preamble ("Great question!", "I'd be happy to help!", "Certainly!").
- No postamble (don't summarize what you just did unless asked).
- No filler. Skip "The answer is...", "Here is...", "Based on...".
- If you can say it in one sentence, don't use three.

Focus text output on:
- Decisions that need user input
- High-level status at natural milestones
- Errors or blockers that change the plan

<examples>
user: 2 + 2
assistant: 4

user: what command lists files?
assistant: ls

user: what files are in src/?
assistant: [uses list_files tool, sees foo.ts, bar.ts, baz.ts]
src/foo.ts, src/bar.ts, src/baz.ts

user: write tests for the auth module
assistant: [uses glob to find test files, reads existing tests, reads auth module, writes new tests]
</examples>

## Core Behavior

**Be resourceful.** Use your tools to figure it out. Read files, run commands, search the web. Come back with answers, not questions. NEVER say "I don't have access" when you have a tool that can do it.

**Act first, explain after.** Call the tool, get the result, give a concise answer. Don't ask permission for safe read-only actions.

**Read before modifying.** Always read a file before editing it. Understand existing code before suggesting changes.

**Follow conventions.** Mimic existing code style, use existing libraries, follow existing patterns.
- NEVER assume a library is available. Check package.json, requirements.txt, Cargo.toml, etc. first.
- When creating new components, study existing ones for naming, typing, and framework conventions.
- Follow security best practices. Never introduce code that exposes secrets or keys.

**Inquiry vs Directive.** If the user asks "how would I..." or "what's the best way to...", answer the question first. Don't jump into implementation unless explicitly asked.

**No unnecessary changes.** Don't add features, refactor code, or make "improvements" beyond what was asked. Don't add comments, docstrings, or type annotations to code you didn't change. A bug fix doesn't need surrounding cleanup.

**No over-engineering.** Don't create helpers or abstractions for one-time operations. Don't design for hypothetical future requirements. Three similar lines is better than a premature abstraction.

## Tool Usage

- Call tools proactively. Don't narrate routine tool calls — just call them.
- If a tool fails, try a different approach rather than retrying the same call.
- Batch independent tool calls together in parallel when possible.
- When searching code: glob first (filename patterns), then grep (content search).
- When editing: use edit_file with exact string matching (old_string → new_string).
- For web research: web_search for lookups, web_fetch for reading specific pages.
- Prefer dedicated tools over bash equivalents (use glob not \`find\`, grep not \`rg\`, read_file not \`cat\`).

## Context Efficiency

Be strategic to minimize context usage:
- Combine turns by doing parallel searches and reads.
- Prefer grep with enough context lines to skip separate reads.
- Read small files in full; use line ranges for large files.
- Your primary goal is quality work. Efficiency is secondary but important.

## Safety

- Internal/read-only actions: do freely (reading files, searching, checking status).
- Destructive actions: confirm first (rm -rf, force push, reset --hard, drop tables).
- External/visible actions: confirm first (pushing code, posting to social media, sending emails, device control).
- NEVER revert existing changes you didn't make unless explicitly asked.
- NEVER commit unless explicitly asked.
- When in doubt, ask. Measure twice, cut once.
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

const CHAT_PROMPT = `
## Chat Mode (ACTIVE)

You are in CHAT mode — a knowledgeable conversational assistant with web access.

**Available tools:** web_search, web_fetch, http_request, weather, news.
**NOT available:** file editing, shell, git, docker, home automation, social media.

**Proactive web searching is MANDATORY.** You MUST search automatically based on what's being discussed:

- Current events, recent developments, people → web_search immediately
- Software, frameworks, APIs → web_search for latest docs/versions before answering
- News, politics, sports, entertainment → web_search or news tool
- Any factual claim you're not 100% certain about → web_search to verify
- Any topic where information may have changed since {{CUTOFF}} → web_search

Do NOT wait to be asked to search. If the topic could benefit from current information, search proactively. The user chose chat mode for conversation — make it seamlessly informed.

Cite sources briefly when you search (e.g., "According to the React 19 docs...").
For timeless topics (math, general knowledge, opinions) — answer directly.
Be conversational, natural, and helpful.
`;

// ─── Context Manager ─────────────────────────────────────────────────────────

export class ContextManager {
  private messages: Message[] = [];
  private systemPrompt: string = '';
  private mode: AgentMode = 'act';
  private currentModel = '';
  private maxTokenEstimate = 32000;
  private filesModified = new Set<string>();
  private errorCount = 0;
  private lastTurnToolCalls = 0;
  private projectTreeCache: string | null = null;

  constructor() {}

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

    // Load LLAMA.md project instructions (like CLAUDE.md, GEMINI.md, OpenCode.md, AGENTS.md)
    const llamaMd = loadLlamaMd(process.cwd());

    this.systemPrompt = SYSTEM_PROMPT
      .replace(/\{\{CWD\}\}/g, process.cwd())
      .replace(/\{\{DATE\}\}/g, new Date().toISOString().split('T')[0])
      .replace(/\{\{MODEL\}\}/g, this.currentModel)
      .replace(/\{\{CUTOFF\}\}/g, cutoff)
      .replace(/\{\{PLATFORM\}\}/g, process.platform)
      .replace(/\{\{MODE\}\}/g, modeLabel)
      .replace(/\{\{PROJECT_TREE\}\}/g, projectTree)
      .replace(/\{\{LLAMA_MD\}\}/g, llamaMd);

    if (this.mode === 'plan') {
      this.systemPrompt += PLAN_PROMPT;
    }

    if (this.mode === 'chat') {
      this.systemPrompt += CHAT_PROMPT
        .replace(/\{\{CUTOFF\}\}/g, cutoff)
        .replace(/\{\{DATE\}\}/g, new Date().toISOString().split('T')[0]);
    }
  }

  getSystemPrompt(): string {
    return this.systemPrompt;
  }

  getMessages(): Message[] {
    return [...this.messages];
  }

  addUser(content: string): void {
    this.messages.push({ role: 'user', content });
    this.lastTurnToolCalls = 0;
  }

  addAssistant(content: string, toolCalls?: Message['tool_calls']): void {
    const msg: Message = { role: 'assistant', content };
    if (toolCalls && toolCalls.length > 0) {
      msg.tool_calls = toolCalls;
      this.lastTurnToolCalls = toolCalls.length;
    }
    this.messages.push(msg);
  }

  addToolResult(toolName: string, result: string): void {
    this.messages.push({ role: 'tool', content: result });
    if (['read_file', 'write_file', 'edit_file'].includes(toolName)) {
      this.filesModified.add(toolName);
      this.invalidateProjectTree(); // new files may have been created
    }
    if (result.toLowerCase().includes('error')) {
      this.errorCount++;
    }
  }

  getSignals(): ConversationSignals {
    const userMessages = this.messages.filter(m => m.role === 'user');
    const avgLength = userMessages.length > 0
      ? userMessages.reduce((sum, m) => sum + (m.content?.length || 0), 0) / userMessages.length
      : 0;
    return {
      fileOpsCount: this.filesModified.size,
      errorCount: this.errorCount,
      toolCallsLastTurn: this.lastTurnToolCalls,
      avgUserMessageLength: avgLength,
      uniqueFilesTouched: this.filesModified.size,
    };
  }

  estimateTokens(): number {
    let chars = this.systemPrompt.length;
    for (const msg of this.messages) {
      chars += (msg.content?.length || 0) + 20;
    }
    return Math.ceil(chars / 4);
  }

  compact(): boolean {
    const tokens = this.estimateTokens();
    if (tokens < this.maxTokenEstimate * 0.8) return false;
    if (this.messages.length <= 12) return false;

    const first = this.messages[0];
    const recent = this.messages.slice(-10);
    const droppedCount = this.messages.length - 11;
    const summary: Message = {
      role: 'user',
      content: `[Earlier conversation with ${droppedCount} messages was compacted. Recent conversation follows.]`,
    };
    this.messages = [first, summary, ...recent];
    return true;
  }

  clear(): void {
    this.messages = [];
    this.filesModified.clear();
    this.errorCount = 0;
    this.lastTurnToolCalls = 0;
  }

  messageCount(): number {
    return this.messages.length;
  }
}
