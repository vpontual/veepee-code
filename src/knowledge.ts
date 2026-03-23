import { writeFile, readFile, mkdir } from 'fs/promises';
import { resolve, join } from 'path';
import { existsSync } from 'fs';
import type { Message, ToolCall } from 'ollama';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface KnowledgeStateData {
  project: string;
  cwd: string;
  userIntent: string;
  decisions: string[];
  filesRead: string[];
  filesModified: string[];
  currentTask: string;
  facts: string[];
  errors: string[];
  openQuestions: string[];
  turn: number;
}

const SESSIONS_DIR = resolve(process.env.HOME || '~', '.veepee-code', 'sessions');

// ─── Intent/Decision extraction patterns ─────────────────────────────────────

const DECISION_PATTERNS = [
  /\b(?:i'll|let's|we'll|i will|let me|going to)\s+(?:use|go with|choose|pick|try|implement|create|switch to)\s+(.+?)(?:\.|,|$)/gi,
  /\b(?:decided|choosing|picked|selected|using|switching to)\s+(.+?)(?:\.|,|$)/gi,
];

const ERROR_PATTERN = /\b(?:error|failed|exception|traceback|cannot|unable to|denied|refused)\b/i;

// ─── KnowledgeState Class ────────────────────────────────────────────────────

export class KnowledgeState {
  private data: KnowledgeStateData;
  private sessionId: string;
  private dirty = false;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
    this.data = {
      project: '',
      cwd: process.cwd(),
      userIntent: '',
      decisions: [],
      filesRead: [],
      filesModified: [],
      currentTask: '',
      facts: [],
      errors: [],
      openQuestions: [],
      turn: 0,
    };
  }

  /** Update the knowledge state after an agent turn */
  update(
    userMessage: string | null,
    assistantContent: string | null,
    toolCalls: ToolCall[] | undefined,
    toolResults: Array<{ name: string; content: string; success: boolean }>,
  ): void {
    this.data.turn++;

    // Extract user intent from latest user message
    if (userMessage) {
      this.data.userIntent = userMessage.slice(0, 120);
      this.data.currentTask = this.extractTask(userMessage);
    }

    // Extract decisions from assistant text
    if (assistantContent) {
      for (const pattern of DECISION_PATTERNS) {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(assistantContent)) !== null) {
          const decision = match[1].trim().slice(0, 100);
          if (decision && !this.data.decisions.includes(decision)) {
            this.data.decisions.push(decision);
          }
        }
      }
    }

    // Extract file ops and errors from tool calls/results
    for (const result of toolResults) {
      const name = result.name;

      if (name === 'read_file' || name === 'glob' || name === 'grep' || name === 'list_files') {
        // Track files read — extract path from tool call args if available
        if (toolCalls) {
          for (const call of toolCalls) {
            if (call.function.name === name) {
              const path = (call.function.arguments as Record<string, unknown>)?.path as string;
              if (path && !this.data.filesRead.includes(path)) {
                this.data.filesRead.push(path);
              }
            }
          }
        }
      }

      if (name === 'write_file' || name === 'edit_file') {
        if (toolCalls) {
          for (const call of toolCalls) {
            if (call.function.name === name) {
              const path = (call.function.arguments as Record<string, unknown>)?.path as string;
              if (path) {
                const entry = `${path}`;
                if (!this.data.filesModified.includes(entry)) {
                  this.data.filesModified.push(entry);
                }
              }
            }
          }
        }
      }

      // Track errors
      if (!result.success || ERROR_PATTERN.test(result.content)) {
        const errorSnippet = result.content.slice(0, 100);
        if (!this.data.errors.some(e => e === errorSnippet)) {
          this.data.errors.push(errorSnippet);
        }
      }
    }

    // Keep arrays bounded
    this.data.decisions = this.data.decisions.slice(-10);
    this.data.filesRead = this.data.filesRead.slice(-20);
    this.data.filesModified = this.data.filesModified.slice(-20);
    this.data.errors = this.data.errors.slice(-5);
    this.data.facts = this.data.facts.slice(-15);
    this.data.openQuestions = this.data.openQuestions.slice(-5);

    this.dirty = true;
  }

  /** Explicit memory update from the model via update_memory tool */
  updateMemory(key: string, value: string): void {
    switch (key) {
      case 'fact':
      case 'facts':
        if (!this.data.facts.includes(value)) {
          this.data.facts.push(value);
        }
        break;
      case 'decision':
      case 'decisions':
        if (!this.data.decisions.includes(value)) {
          this.data.decisions.push(value);
        }
        break;
      case 'question':
      case 'open_question':
        if (!this.data.openQuestions.includes(value)) {
          this.data.openQuestions.push(value);
        }
        break;
      case 'project':
        this.data.project = value;
        break;
      case 'current_task':
        this.data.currentTask = value;
        break;
      default:
        // Generic: store as a fact
        if (!this.data.facts.includes(`${key}: ${value}`)) {
          this.data.facts.push(`${key}: ${value}`);
        }
    }
    this.dirty = true;
  }

  /** Serialize to compact AI-readable format (~200 tokens) */
  serialize(): string {
    const lines: string[] = [];

    if (this.data.project) lines.push(`PROJECT: ${this.data.project}`);
    lines.push(`CWD: ${this.data.cwd}`);
    if (this.data.userIntent) lines.push(`USER_INTENT: ${this.data.userIntent}`);
    if (this.data.currentTask) lines.push(`CURRENT_TASK: ${this.data.currentTask}`);
    if (this.data.decisions.length) lines.push(`DECISIONS: [${this.data.decisions.join(' | ')}]`);
    if (this.data.filesRead.length) lines.push(`FILES_READ: [${this.data.filesRead.join(' | ')}]`);
    if (this.data.filesModified.length) lines.push(`FILES_MODIFIED: [${this.data.filesModified.join(' | ')}]`);
    if (this.data.facts.length) lines.push(`FACTS: [${this.data.facts.join(' | ')}]`);
    if (this.data.errors.length) lines.push(`ERRORS: [${this.data.errors.join(' | ')}]`);
    if (this.data.openQuestions.length) lines.push(`OPEN_QUESTIONS: [${this.data.openQuestions.join(' | ')}]`);
    lines.push(`TURN: ${this.data.turn}`);

    return lines.join('\n');
  }

  /** Format for injection into system prompt */
  toSystemPromptBlock(): string {
    if (this.data.turn === 0) return '';

    return `\n## Conversation Knowledge State\n\nThis contains everything important from our conversation so far. Only the last few messages are shown below.\n\n\`\`\`\n${this.serialize()}\n\`\`\`\n`;
  }

  /** Deserialize from the compact format */
  static deserialize(text: string): KnowledgeStateData {
    const data: KnowledgeStateData = {
      project: '', cwd: '', userIntent: '', decisions: [],
      filesRead: [], filesModified: [], currentTask: '',
      facts: [], errors: [], openQuestions: [], turn: 0,
    };

    for (const line of text.split('\n')) {
      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) continue;

      const key = line.slice(0, colonIdx).trim();
      const val = line.slice(colonIdx + 1).trim();

      switch (key) {
        case 'PROJECT': data.project = val; break;
        case 'CWD': data.cwd = val; break;
        case 'USER_INTENT': data.userIntent = val; break;
        case 'CURRENT_TASK': data.currentTask = val; break;
        case 'TURN': data.turn = parseInt(val, 10) || 0; break;
        case 'DECISIONS': data.decisions = parseArray(val); break;
        case 'FILES_READ': data.filesRead = parseArray(val); break;
        case 'FILES_MODIFIED': data.filesModified = parseArray(val); break;
        case 'FACTS': data.facts = parseArray(val); break;
        case 'ERRORS': data.errors = parseArray(val); break;
        case 'OPEN_QUESTIONS': data.openQuestions = parseArray(val); break;
      }
    }

    return data;
  }

  /** Save knowledge state to disk alongside session */
  async save(): Promise<void> {
    if (!this.dirty) return;
    await mkdir(SESSIONS_DIR, { recursive: true });
    const filePath = join(SESSIONS_DIR, `${this.sessionId}-state.md`);
    await writeFile(filePath, this.serialize());
    this.dirty = false;
  }

  /** Load knowledge state from disk */
  static async load(sessionId: string): Promise<KnowledgeState | null> {
    const filePath = join(SESSIONS_DIR, `${sessionId}-state.md`);
    if (!existsSync(filePath)) return null;

    try {
      const text = await readFile(filePath, 'utf-8');
      const ks = new KnowledgeState(sessionId);
      ks.data = KnowledgeState.deserialize(text);
      return ks;
    } catch {
      return null;
    }
  }

  getData(): KnowledgeStateData {
    return { ...this.data };
  }

  getTurn(): number {
    return this.data.turn;
  }

  setProject(name: string): void {
    this.data.project = name;
    this.dirty = true;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  private extractTask(message: string): string {
    // Simple heuristic: take the first sentence or first 80 chars
    const firstSentence = message.split(/[.!?\n]/)[0]?.trim();
    return (firstSentence || message).slice(0, 80);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseArray(val: string): string[] {
  // Parse "[item1 | item2 | item3]" format (pipe-delimited to avoid breaking on commas in values)
  // Also supports legacy comma-delimited format for backward compatibility
  const trimmed = val.replace(/^\[/, '').replace(/\]$/, '').trim();
  if (!trimmed) return [];
  const delimiter = trimmed.includes(' | ') ? ' | ' : ',';
  return trimmed.split(delimiter).map(s => s.trim()).filter(Boolean);
}
