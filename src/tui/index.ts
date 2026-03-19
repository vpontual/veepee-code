import chalk from 'chalk';
import { marked } from 'marked';
import { markedTerminal } from 'marked-terminal';
import { theme, box, icons } from './theme.js';
import {
  enterAltScreen, exitAltScreen, showCursor, hideCursor,
  moveTo, clearLine, clearScreen, clearBelow,
  getSize, writeAt, center, stripAnsi, truncate, wordWrap,
} from './screen.js';
import { getLogo, getLogoHeight } from './logo.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ModelManager, ModelProfile } from '../models.js';

export { theme, box, icons } from './theme.js';

// ─── Types ───────────────────────────────────────────────────────────────────

interface Message {
  role: 'user' | 'assistant' | 'tool_call' | 'tool_result' | 'system' | 'model_switch' | 'thinking';
  content: string;
  meta?: string;
  success?: boolean;
  timestamp?: number;
  collapsed?: boolean;  // for thinking blocks
}

interface InputState {
  text: string;
  cursor: number;
  history: string[];
  historyIdx: number;
}

/** Tracks the current agent turn's progress — like Claude Code's agent tree view */
interface TurnTracker {
  startTime: number;
  toolCalls: Array<{ name: string; status: 'running' | 'done' | 'error'; elapsed?: number }>;
  tokensEstimate: number;
  model: string;
  active: boolean;
}

// ─── Command Definitions ─────────────────────────────────────────────────────

// ─── Markdown Renderer ───────────────────────────────────────────────────────

// Initialize marked with terminal renderer — reconfigured per render for dynamic width
function setupMarkedTerminal(width: number): void {
  marked.use(markedTerminal({
    code: chalk.hex('#E8A87C'),
    codespan: chalk.hex('#E8A87C').bold,
    strong: chalk.bold.white,
    em: chalk.italic,
    heading: chalk.bold.underline.white,
    listitem: chalk.white,
    link: chalk.hex('#85C7F2').underline,
    paragraph: chalk.white,
    hr: () => chalk.dim('─'.repeat(Math.min(40, width - 4))) + '\n',
    blockquote: chalk.dim.italic,
    width,
    reflowText: true,
    tab: 2,
  }) as never);
}
// Initial setup with default
setupMarkedTerminal(process.stdout.columns ? process.stdout.columns - 6 : 90);

/** Format assistant markdown into terminal-ready lines, word-wrapped to fit */
function formatAssistantMarkdown(content: string, maxWidth: number): string[] {
  try {
    setupMarkedTerminal(maxWidth);
    const rendered = (marked.parse(content) as string).replace(/\n+$/, '');
    const lines: string[] = [];
    for (const line of rendered.split('\n')) {
      const visualLen = stripAnsi(line).length;
      if (visualLen <= maxWidth) {
        lines.push(line);
      } else {
        // Wrap long rendered lines
        const wrapped = wordWrap(stripAnsi(line), maxWidth);
        lines.push(...wrapped);
      }
    }
    return lines;
  } catch {
    return wordWrap(content, maxWidth).map(line => chalk.white(line));
  }
}

// ─── Command Definitions ─────────────────────────────────────────────────────

const COMMANDS = [
  { name: '/model', args: '<name>', description: 'Switch to a specific model' },
  { name: '/model auto', args: '', description: 'Re-enable auto model switching' },
  { name: '/models', args: '', description: 'List all available models with rankings' },
  { name: '/tools', args: '', description: 'List all available tools' },
  { name: '/plan', args: '', description: 'Plan mode — thinking ON, heavy model' },
  { name: '/act', args: '', description: 'Act/Code mode — all tools, coding-ready (default)' },
  { name: '/code', args: '', description: 'Same as /act — all tools, coding-ready' },
  { name: '/chat', args: '', description: 'Chat mode — fast model, web search' },
  { name: '/moe', args: '[strategy]', description: 'Mixture of Experts — 3 models discuss your question' },
  { name: '/moe debate', args: '', description: 'MoE debate — models critique each other' },
  { name: '/moe vote', args: '', description: 'MoE vote — show all 3 responses, you pick' },
  { name: '/moe fastest', args: '', description: 'MoE fastest — first response wins' },
  { name: '/init', args: '', description: 'Create VEEPEE.md for this project' },
  { name: '/setup', args: '', description: 'Validate all tool integrations' },
  { name: '/benchmark', args: '[tier]', description: 'Run benchmarks on all models' },
  { name: '/benchmark results', args: '', description: 'Show latest benchmark results' },
  { name: '/benchmark summary', args: '', description: 'Show benchmark summary' },
  { name: '/permissions', args: '', description: 'Show permission settings' },
  { name: '/revoke', args: '<tool>', description: 'Revoke always-allow for a tool' },
  { name: '/status', args: '', description: 'Show session status' },
  { name: '/clear', args: '', description: 'Clear conversation history' },
  { name: '/compact', args: '', description: 'Compact conversation to free context' },
  { name: '/help', args: '', description: 'Show all commands' },
  { name: '/save', args: '[name]', description: 'Save current conversation as a session' },
  { name: '/sessions', args: '', description: 'List all saved sessions' },
  { name: '/resume', args: '<name>', description: 'Resume a saved session' },
  { name: '/rename', args: '<name>', description: 'Rename current session' },
  { name: '/add-dir', args: '<path>', description: 'Add a working directory' },
  { name: '/worktree', args: '[cmd]', description: 'Git worktree isolation (create/list/cleanup)' },
  { name: '/effort', args: '<level>', description: 'Set effort level (low/medium/high)' },
  { name: '/benchmark context', args: '', description: 'Probe optimal context sizes per model' },
  { name: '/quit', args: '', description: 'Exit VEEPEE Code' },
  { name: '/exit', args: '', description: 'Exit VEEPEE Code' },
];

// ─── TUI Class ───────────────────────────────────────────────────────────────

export class TUI {
  private messages: Message[] = [];
  private input: InputState = { text: '', cursor: 0, history: [], historyIdx: -1 };
  private commandMenuVisible = false;
  private commandMenuSelection = 0;
  private filteredCommands: typeof COMMANDS = [];
  private scrollOffset = 0;
  private state: 'welcome' | 'conversation' | 'waiting' = 'welcome';
  private modelName = '';
  private modelSize = '';
  private providerName = 'Ollama Fleet';
  private toolCount = 0;
  private modelCount = 0;
  private tokenCount = 0;
  private tokenPercent = 0;
  private messageCount = 0;
  private elapsed = 0;
  private version = '0.1.0';
  private apiPort = 8484;
  private tips = [
    'Permission system prevents unauthorized tool execution',
    '/benchmark ranks all your models by actual performance',
    'Model auto-switches based on task complexity',
    'API on localhost:8484 lets Claude Code collaborate',
    '/models shows all available models with scores',
    'Press Ctrl+C to interrupt, /quit to exit',
  ];
  private currentTip = 0;
  private resolveInput: ((value: string) => void) | null = null;
  private rejectInput: ((reason: Error) => void) | null = null;
  private permissionResolve: ((value: string) => void) | null = null;
  private streamBuffer = '';
  private streamActive = false;
  private turnTracker: TurnTracker | null = null;
  private turnTrackerInterval: ReturnType<typeof setInterval> | null = null;
  private abortHandler: (() => void) | null = null;

  constructor() {
    this.currentTip = Math.floor(Math.random() * this.tips.length);
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────

  start(info: {
    model: string; modelSize: string; toolCount: number;
    modelCount: number; version: string; apiPort: number;
  }): void {
    this.modelName = info.model;
    this.modelSize = info.modelSize;
    this.toolCount = info.toolCount;
    this.modelCount = info.modelCount;
    this.version = info.version;
    this.apiPort = info.apiPort;

    enterAltScreen();
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.on('data', this.handleKey.bind(this));
    process.stdout.on('resize', () => this.render());

    // Enable mouse wheel tracking (SGR extended mode for modern terminals)
    process.stdout.write('\x1b[?1000h'); // enable basic mouse
    process.stdout.write('\x1b[?1006h'); // enable SGR extended mouse

    this.render();
  }

  stop(): void {
    if (this.turnTrackerInterval) clearInterval(this.turnTrackerInterval);
    // Disable mouse tracking
    process.stdout.write('\x1b[?1006l');
    process.stdout.write('\x1b[?1000l');
    process.stdin.setRawMode?.(false);
    process.stdin.removeAllListeners('data');
    exitAltScreen();
    showCursor();
  }

  // ─── Public API ────────────────────────────────────────────────────

  /** Wait for user input. Returns the entered text. */
  getInput(placeholder?: string): Promise<string> {
    this.input.text = '';
    this.input.cursor = 0;
    this.state = this.messages.length > 0 ? 'conversation' : 'welcome';
    this.render();

    return new Promise((resolve, reject) => {
      this.resolveInput = resolve;
      this.rejectInput = reject;
    });
  }

  /** Show a permission prompt and wait for y/a/n */
  async promptPermission(toolName: string, args: Record<string, unknown>, reason?: string): Promise<string> {
    this.addMessage({
      role: 'system',
      content: `${icons.warn} Permission required: ${toolName}${reason ? ` (${reason})` : ''}`,
    });

    const argsSummary = Object.entries(args)
      .map(([k, v]) => {
        const val = typeof v === 'string'
          ? (v.length > 80 ? v.slice(0, 77) + '...' : v)
          : JSON.stringify(v);
        return `  ${theme.dim(k)}: ${val}`;
      })
      .join('\n');
    if (argsSummary) {
      this.addMessage({ role: 'system', content: argsSummary });
    }
    this.addMessage({
      role: 'system',
      content: `${theme.dim('[y] Yes  [a] Always allow')} ${theme.accent(toolName)} ${theme.dim(' [n] No')}`,
    });
    this.render();

    return new Promise((resolve) => {
      this.permissionResolve = resolve;
    });
  }

  /** Add a user message and start turn tracking */
  /** Set a handler to call when user presses Ctrl+C during agent execution */
  setAbortHandler(handler: () => void): void {
    this.abortHandler = handler;
  }

  addUserMessage(content: string): void {
    this.addMessage({ role: 'user', content, timestamp: Date.now() });
    this.state = 'waiting';

    // Clear the input box and reset scroll to bottom
    this.input.text = '';
    this.input.cursor = 0;
    this.scrollOffset = 0;
    this.commandMenuVisible = false;

    // Start turn tracker (agent tree view)
    this.turnTracker = {
      startTime: Date.now(),
      toolCalls: [],
      tokensEstimate: 0,
      model: this.modelName,
      active: true,
    };

    // Live-update the tracker display every 100ms
    if (this.turnTrackerInterval) clearInterval(this.turnTrackerInterval);
    this.turnTrackerInterval = setInterval(() => {
      if (this.turnTracker?.active) this.render();
    }, 500);

    this.render();
  }

  /** Start streaming assistant text */
  startStream(): void {
    this.streamBuffer = '';
    this.streamActive = true;
  }

  /** Append streaming text */
  appendStream(text: string): void {
    this.streamBuffer += text;
    this.renderStreamArea();
  }

  /** End streaming and commit as message */
  endStream(): void {
    if (this.streamBuffer.trim()) {
      this.addMessage({ role: 'assistant', content: this.streamBuffer.trim() });
    }
    this.streamBuffer = '';
    this.streamActive = false;
    this.state = 'conversation';
    this.render();
  }

  /** Show a tool call */
  showToolCall(name: string, args: Record<string, unknown>): void {
    const argsStr = Object.entries(args)
      .map(([k, v]) => {
        const val = typeof v === 'string'
          ? (v.length > 60 ? v.slice(0, 57) + '...' : v)
          : JSON.stringify(v);
        return `${k}=${val}`;
      })
      .join(' ');
    this.addMessage({ role: 'tool_call', content: `${name} ${argsStr}` });

    // Track in turn tracker
    if (this.turnTracker) {
      this.turnTracker.toolCalls.push({ name, status: 'running' });
    }
    this.render();
  }

  /** Show a tool result */
  showToolResult(name: string, success: boolean, output: string): void {
    const lines = output.split('\n');
    const preview = lines.length > 3
      ? lines.slice(0, 3).join('\n') + `\n... (${lines.length - 3} more lines)`
      : output;
    this.addMessage({ role: 'tool_result', content: preview, success, meta: name });

    // Update tracker
    if (this.turnTracker) {
      const tc = [...this.turnTracker.toolCalls].reverse().find(t => t.name === name && t.status === 'running');
      if (tc) {
        tc.status = success ? 'done' : 'error';
        tc.elapsed = Date.now() - this.turnTracker.startTime;
      }
      this.turnTracker.tokensEstimate += Math.ceil(output.length / 4);
    }
    this.render();
  }

  /** Show model switch */
  showModelSwitch(from: string, to: string): void {
    this.modelName = to;
    this.addMessage({ role: 'model_switch', content: `${from} ${icons.arrow} ${to}` });
    this.render();
  }

  /** Show permission denied */
  showPermissionDenied(name: string): void {
    this.addMessage({ role: 'system', content: `${icons.lock} ${name} — skipped (denied)` });
    this.render();
  }

  /** Show error */
  /** Show thinking — collapsed by default with first line preview */
  showThinking(content: string): void {
    if (content === '...') {
      // Pulsing indicator — update last thinking message if it exists
      const lastMsg = this.messages[this.messages.length - 1];
      if (lastMsg?.role === 'thinking' && lastMsg.content === '...') {
        return; // already showing indicator
      }
      this.addMessage({ role: 'thinking', content: '...', collapsed: true });
      this.render();
      return;
    }

    // Full thinking content — replace the indicator with collapsed block
    const lastIdx = this.messages.findLastIndex(m => m.role === 'thinking');
    if (lastIdx >= 0) {
      this.messages[lastIdx] = { role: 'thinking', content, collapsed: true };
    } else {
      this.addMessage({ role: 'thinking', content, collapsed: true });
    }
    this.render();
  }

  showError(msg: string): void {
    this.addMessage({ role: 'system', content: `${theme.error(msg)}` });
    this.state = 'conversation';
    this.render();
  }

  /** Show an info/system message */
  showInfo(msg: string): void {
    this.addMessage({ role: 'system', content: msg });
    // Switch to conversation view if we have messages (e.g., benchmark progress)
    if (this.state === 'welcome' && this.messages.length > 0) {
      this.state = 'conversation';
    }
    this.render();
  }

  /** Update context stats */
  updateStats(tokens: number, percent: number, messages: number, elapsed: number): void {
    this.tokenCount = tokens;
    this.tokenPercent = percent;
    this.messageCount = messages;
    this.elapsed = elapsed;
  }

  updateModel(name: string, size?: string): void {
    this.modelName = name;
    if (size) this.modelSize = size;
    this.render();
  }

  /** Show the completion badge after agent finishes */
  showCompletionBadge(model: string, elapsed: number, metrics?: { evalCount?: number; promptEvalCount?: number; tokensPerSecond?: number }): void {
    // Stop turn tracker
    if (this.turnTracker) {
      this.turnTracker.active = false;
    }
    if (this.turnTrackerInterval) {
      clearInterval(this.turnTrackerInterval);
      this.turnTrackerInterval = null;
    }

    const secs = (elapsed / 1000).toFixed(1);
    const toolCount = this.turnTracker?.toolCalls.length || 0;

    // Use real Ollama metrics if available, otherwise fall back to estimate
    const evalTokens = metrics?.evalCount || this.turnTracker?.tokensEstimate || 0;
    const promptTokens = metrics?.promptEvalCount || 0;
    const tps = metrics?.tokensPerSecond || 0;

    const tokStr = evalTokens > 1000 ? `${(evalTokens / 1000).toFixed(1)}k` : String(evalTokens);
    const promptStr = promptTokens > 0 ? ` ${icons.dot} ${promptTokens > 1000 ? `${(promptTokens / 1000).toFixed(1)}k` : promptTokens} prompt` : '';
    const tpsStr = tps > 0 ? ` ${icons.dot} ${tps} tok/s` : '';

    this.addMessage({
      role: 'system',
      content: `${theme.dim(`${icons.toolDone}  Build ${icons.dot} ${model} ${icons.dot} ${toolCount} tool calls ${icons.dot} ${tokStr} tokens${promptStr}${tpsStr} ${icons.dot} ${secs}s`)}`,
    });

    this.turnTracker = null;
    this.state = 'conversation';
    this.render();
  }

  // ─── Rendering ─────────────────────────────────────────────────────

  render(): void {
    const { rows, cols } = getSize();
    if (this.state === 'welcome') {
      this.renderWelcome(rows, cols);
    } else {
      this.renderConversation(rows, cols);
    }
    // NOTE: cursor positioning is the LAST thing renderInputBox does,
    // and renderInputBox is called AFTER renderStatusBar in both paths.
  }

  private renderWelcome(rows: number, cols: number): void {
    clearScreen();

    const logo = getLogo(cols);
    const logoHeight = logo.length;

    // Calculate vertical position — logo centered in upper half
    const inputBoxHeight = 5;
    const contentHeight = logoHeight + 4 + inputBoxHeight;
    const startRow = Math.max(2, Math.floor((rows - contentHeight) / 2) - 2);

    // Draw logo centered
    for (let i = 0; i < logo.length; i++) {
      writeAt(startRow + i, 1, center(logo[i], cols));
    }

    // Status bar FIRST (so cursor isn't left here)
    this.renderStatusBar(rows, cols);

    // Input box LAST (its final action is positioning the cursor)
    const boxRow = startRow + logoHeight + 3;
    this.renderInputBox(boxRow, cols);
  }

  private renderConversation(rows: number, cols: number): void {
    // Clear by overwriting each line
    hideCursor();
    for (let r = 1; r <= rows; r++) {
      moveTo(r, 1);
      process.stdout.write(' '.repeat(cols));
    }


    // Layout: turn tracker (if active), messages area, input box, status bar
    // Input box = 4 rows: border + text + model + border
    // Below box = 1 row: hints
    // Below hints = 1 row: status bar
    const statusBarHeight = 1;
    const hintsHeight = 1;
    const inputBoxHeight = 4;  // ╭ border + text + model + ╰ border
    const totalBottomHeight = inputBoxHeight + hintsHeight + statusBarHeight;
    const trackerHeight = this.turnTracker?.active ? Math.min(this.turnTracker.toolCalls.length + 2, 8) : 0;
    const messagesEndRow = rows - totalBottomHeight - trackerHeight - 1;

    // Render messages (start at row 3 — rows 1-2 can be clipped by terminal title/tab bar)
    this.renderMessages(3, messagesEndRow, cols);

    // Render turn tracker (agent tree view) above input box
    if (this.turnTracker?.active && trackerHeight > 0) {
      this.renderTurnTracker(messagesEndRow + 1, cols);
    }

    // Status bar FIRST (so cursor isn't left here)
    this.renderStatusBar(rows, cols);

    // Input box LAST (its final action is positioning the cursor)
    const inputRow = rows - totalBottomHeight;
    this.renderInputBox(inputRow, cols);
  }

  private renderMessages(startRow: number, endRow: number, cols: number): void {
    const maxWidth = cols - 4;
    const leftPad = 2;

    let row = startRow;

    // Combine committed messages + current stream
    const allMessages = [...this.messages];

    const renderedLines: { line: string; role: string }[] = [];
    for (let mi = 0; mi < allMessages.length; mi++) {
      const msg = allMessages[mi];
      const lines = this.formatMessage(msg, maxWidth);
      for (const line of lines) {
        renderedLines.push({ line, role: msg.role });
      }
      // Add spacer between messages (but not after the last one)
      if (mi < allMessages.length - 1) {
        renderedLines.push({ line: '', role: 'spacer' });
      }
    }

    // Add stream buffer if active
    if (this.streamActive && this.streamBuffer) {
      renderedLines.push({ line: '', role: 'spacer' });
      const wrapped = wordWrap(this.streamBuffer, maxWidth);
      for (const line of wrapped) {
        renderedLines.push({ line, role: 'assistant' });
      }
    }

    // Scroll: auto-scroll to bottom unless user has scrolled up
    const visibleRows = endRow - startRow;
    let startLine = 0;
    if (renderedLines.length > visibleRows) {
      const maxScroll = renderedLines.length - visibleRows;
      if (this.scrollOffset > 0) {
        // User has scrolled up — respect their offset
        this.scrollOffset = Math.min(this.scrollOffset, maxScroll);
        startLine = maxScroll - this.scrollOffset;
      } else {
        // Auto-scroll to show latest content
        startLine = maxScroll;
      }
    } else {
      this.scrollOffset = 0; // content fits, reset scroll
    }

    for (let i = startLine; i < renderedLines.length && row <= endRow; i++) {
      writeAt(row, leftPad, renderedLines[i].line);
      row++;
    }
  }

  private formatMessage(msg: Message, maxWidth: number): string[] {
    switch (msg.role) {
      case 'user': {
        // Full-width highlighted block with colored left border (like OpenCode)
        const contentWidth = maxWidth - 3;
        const wrapped = wordWrap(msg.content, contentWidth);
        const bg = chalk.bgHex('#2A2A4A');
        return wrapped.map(wl => {
          const padded = wl + ' '.repeat(Math.max(0, contentWidth - stripAnsi(wl).length));
          return bg(chalk.hex('#85C7F2')('│') + ' ' + chalk.white.bold(padded));
        });
      }

      case 'assistant': {
        return formatAssistantMarkdown(msg.content, maxWidth);
      }

      case 'tool_call': {
        return [theme.tool(`${icons.tool} `) + theme.dim(truncate(msg.content, maxWidth - 3))];
      }

      case 'tool_result': {
        const icon = msg.success ? theme.success(icons.check) : theme.error(icons.cross);
        const lines = msg.content.split('\n').slice(0, 8);
        return lines.map((line, i) => {
          const prefix = i === 0 ? `  ${icon} ` : '    ';
          // Colorize diff lines
          if (line.startsWith('+ ')) {
            return prefix + chalk.green(truncate(line, maxWidth - 6));
          } else if (line.startsWith('- ')) {
            return prefix + chalk.red(truncate(line, maxWidth - 6));
          }
          return prefix + theme.dim(truncate(line, maxWidth - 6));
        });
      }

      case 'thinking': {
        if (msg.content === '...') {
          // Pulsing indicator
          const frames = ['◐', '◓', '◑', '◒'];
          const frame = frames[Math.floor(Date.now() / 200) % frames.length];
          return [theme.dim(`  ${frame} Thinking...`)];
        }
        // Collapsed thinking block — show first line + expand hint
        const thinkLines = msg.content.split('\n');
        const preview = thinkLines[0].slice(0, maxWidth - 20);
        const lineCount = thinkLines.length;
        if (msg.collapsed && lineCount > 1) {
          return [
            theme.dim(`  ${icons.thinking} Thought (${lineCount} lines) `) + theme.dimmer(truncate(preview, maxWidth - 30)),
          ];
        }
        // Expanded — show all lines dimmed
        return thinkLines.slice(0, 20).map(l => theme.dimmer(`  │ ${truncate(l, maxWidth - 6)}`));
      }

      case 'model_switch': {
        return [theme.warning(`  ${icons.thinking} Model: ${msg.content}`)];
      }

      case 'system': {
        return [theme.dim(`  ${msg.content}`)];
      }

      default:
        return [msg.content];
    }
  }

  /** Render the live turn tracker — shows tool calls in progress like Claude Code's agent tree */
  private renderTurnTracker(startRow: number, cols: number): void {
    if (!this.turnTracker) return;

    const maxWidth = cols - 4;
    const leftPad = 2;
    const elapsed = ((Date.now() - this.turnTracker.startTime) / 1000).toFixed(1);
    const toolCount = this.turnTracker.toolCalls.length;
    const tokStr = this.turnTracker.tokensEstimate > 1000
      ? `${(this.turnTracker.tokensEstimate / 1000).toFixed(1)}k`
      : String(this.turnTracker.tokensEstimate);

    // Spinner
    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    const frame = frames[Math.floor(Date.now() / 80) % frames.length];

    // Header: Running... (3 tool calls · 1.2k tokens · 4.5s)
    const header = `${theme.accent(frame)} ${theme.textBold('Running...')} ${theme.dim(`(${toolCount} tool calls ${icons.dot} ${tokStr} tokens ${icons.dot} ${elapsed}s)`)}`;
    writeAt(startRow, leftPad, header);

    // Tool call tree — show last N calls with tree connectors
    const maxVisible = 5;
    const visibleCalls = this.turnTracker.toolCalls.slice(-maxVisible);
    const hasMore = this.turnTracker.toolCalls.length > maxVisible;

    let row = startRow + 1;

    if (hasMore) {
      writeAt(row, leftPad, theme.dim(`  ${icons.dot}${icons.dot}${icons.dot} ${this.turnTracker.toolCalls.length - maxVisible} earlier`));
      row++;
    }

    for (let i = 0; i < visibleCalls.length; i++) {
      const tc = visibleCalls[i];
      const isLast = i === visibleCalls.length - 1;
      const connector = isLast ? '└─' : '├─';

      let statusIcon: string;
      let statusColor = theme.dim;
      if (tc.status === 'running') {
        statusIcon = theme.accent(frame);
        statusColor = theme.accent;
      } else if (tc.status === 'done') {
        statusIcon = theme.success(icons.check);
      } else {
        statusIcon = theme.error(icons.cross);
        statusColor = theme.error;
      }

      const elapsedStr = tc.elapsed ? theme.dim(` ${(tc.elapsed / 1000).toFixed(1)}s`) : '';
      writeAt(row, leftPad, `  ${theme.dim(connector)} ${statusIcon} ${statusColor(tc.name)}${elapsedStr}`);
      row++;
    }
  }

  private renderInputBox(topRow: number, cols: number): void {
    const boxWidth = cols - 4;
    const leftPad = 2;

    // Layout:
    // topRow+0: ╭─── top border
    // topRow+1: │ user text input  │   ← cursor goes here
    // topRow+2: │ Build  model...  │
    // topRow+3: ╰─── bottom border
    // topRow+4: keyboard hints

    // Top border
    const topBorder = theme.borderFocused(
      box.roundTl + box.h.repeat(boxWidth - 2) + box.roundTr
    );
    writeAt(topRow, leftPad, topBorder);

    // Input line
    const inputText = this.input.text || '';
    const contentWidth = boxWidth - 4;
    let displayLine: string;

    if (inputText) {
      // User text — no ANSI codes, padEnd works correctly
      const truncated = inputText.length > contentWidth ? inputText.slice(0, contentWidth - 1) + '…' : inputText;
      displayLine = truncated + ' '.repeat(Math.max(0, contentWidth - truncated.length));
    } else {
      // Placeholder — has ANSI codes, must pad by visual width
      const placeholderText = 'Ask anything... "Fix the bug in auth.ts"';
      const visual = placeholderText.slice(0, contentWidth);
      const padding = ' '.repeat(Math.max(0, contentWidth - visual.length));
      displayLine = theme.dimmer(visual) + padding;
    }

    writeAt(topRow + 1, leftPad,
      theme.borderFocused(box.v) + ' ' + displayLine + ' ' + theme.borderFocused(box.v)
    );

    // Model info line
    const modelInfo = `${theme.accent('Build')}  ${theme.text(this.modelName)} ${theme.dim(this.modelSize)} ${theme.dim('(default)')} ${theme.dimmer(this.providerName)}`;
    const modelInfoClean = stripAnsi(modelInfo);
    const modelPadded = modelInfoClean.length < contentWidth
      ? modelInfo + ' '.repeat(contentWidth - modelInfoClean.length)
      : truncate(modelInfo, contentWidth);

    writeAt(topRow + 2, leftPad,
      theme.borderFocused(box.v) + ' ' + modelPadded + ' ' + theme.borderFocused(box.v)
    );

    // Bottom border
    const bottomBorder = theme.borderFocused(
      box.roundBl + box.h.repeat(boxWidth - 2) + box.roundBr
    );
    writeAt(topRow + 3, leftPad, bottomBorder);

    // Command menu (rendered ABOVE the input box, like OpenCode)
    if (this.commandMenuVisible && this.filteredCommands.length > 0) {
      const menuMaxVisible = Math.min(this.filteredCommands.length, 12);
      const menuStartRow = topRow - menuMaxVisible - 1;

      // Menu border top
      writeAt(menuStartRow, leftPad, theme.border(box.roundTl + box.h.repeat(boxWidth - 2) + box.roundTr));

      for (let i = 0; i < menuMaxVisible; i++) {
        const cmd = this.filteredCommands[i];
        const isSelected = i === this.commandMenuSelection;
        const row = menuStartRow + 1 + i;

        const nameStr = cmd.name.padEnd(22);
        const descStr = truncate(cmd.description, boxWidth - 28);

        if (isSelected) {
          // Highlighted row
          const line = ` ${theme.brandBold(nameStr)} ${theme.text(descStr)}`;
          const lineLen = stripAnsi(line).length;
          const padded = line + ' '.repeat(Math.max(0, boxWidth - 4 - lineLen));
          writeAt(row, leftPad, theme.border(box.v) + chalk.bgHex('#2A2A4A')(` ${padded} `) + theme.border(box.v));
        } else {
          const line = ` ${theme.accent(nameStr)} ${theme.dim(descStr)}`;
          const lineLen = stripAnsi(line).length;
          const padded = line + ' '.repeat(Math.max(0, boxWidth - 4 - lineLen));
          writeAt(row, leftPad, theme.border(box.v) + ` ${padded} ` + theme.border(box.v));
        }
      }

      // Menu border bottom
      writeAt(menuStartRow + menuMaxVisible + 1, leftPad, theme.border(box.roundBl + box.h.repeat(boxWidth - 2) + box.roundBr));
    }

    // Keyboard hints below box
    const hints = `${theme.textBold('tab')} ${theme.dim('tools')}  ${theme.textBold('ctrl+p')} ${theme.dim('commands')}  ${theme.textBold('/help')} ${theme.dim('help')}`;
    writeAt(topRow + 4, leftPad + 2, center(hints, boxWidth - 4));

    // CURSOR POSITIONING — absolute last action of this function.
    // This is the ONLY place cursor position is set. No other code touches it.
    if (this.resolveInput) {
      showCursor();
      // Text line is at topRow+1. Cursor column: border(1) + space(1) + typed chars
      moveTo(topRow + 1, leftPad + 2 + this.input.cursor);
    } else {
      hideCursor();
    }
  }

  private lastRenderTime = 0;
  private renderPending = false;

  private renderStreamArea(): void {
    // Throttle renders during streaming to avoid CPU thrashing on fast models
    const now = Date.now();
    if (now - this.lastRenderTime < 50) { // max 20fps
      if (!this.renderPending) {
        this.renderPending = true;
        setTimeout(() => {
          this.renderPending = false;
          this.lastRenderTime = Date.now();
          this.render();
        }, 50);
      }
      return;
    }
    this.lastRenderTime = now;
    this.render();
  }

  private renderStatusBar(row: number, cols: number): void {
    const cwd = process.cwd().replace(process.env.HOME || '', '~');
    const left = ` ${cwd}`;

    // Right side: context stats + version
    const contextInfo = this.messageCount > 0
      ? `${this.tokenCount.toLocaleString()} tok ${this.tokenPercent}%  `
      : '';
    const right = `${contextInfo}${icons.dot} API :${this.apiPort}  v${this.version} ${icons.llama} `;

    const padding = Math.max(0, cols - stripAnsi(left).length - stripAnsi(right).length);

    moveTo(row, 1);
    process.stdout.write(
      theme.dim(left) + ' '.repeat(padding) + theme.dim(right)
    );
  }

  // ─── Tip rotation ──────────────────────────────────────────────────

  private getTip(): string {
    const tip = this.tips[this.currentTip % this.tips.length];
    return `${theme.warning(icons.dot)} ${theme.dim('Tip')} ${theme.muted(tip)}`;
  }

  // ─── Input Handling ────────────────────────────────────────────────

  private handleKey(data: Buffer): void {
    const key = data.toString();

    // Mouse wheel events (SGR extended: \x1b[<button;x;yM or m)
    const sgrMatch = key.match(/\x1b\[<(\d+);\d+;\d+[Mm]/);
    if (sgrMatch) {
      const button = parseInt(sgrMatch[1], 10);
      if (button === 64) {
        // Scroll up
        this.scrollOffset += 3;
        this.render();
      } else if (button === 65) {
        // Scroll down
        this.scrollOffset = Math.max(0, this.scrollOffset - 3);
        this.render();
      }
      return;
    }

    // Permission prompt mode
    if (this.permissionResolve) {
      if (key === 'y' || key === 'Y') {
        this.permissionResolve('y');
        this.permissionResolve = null;
      } else if (key === 'a' || key === 'A') {
        this.permissionResolve('a');
        this.permissionResolve = null;
      } else if (key === 'n' || key === 'N' || key === '\x1b') {
        this.permissionResolve('n');
        this.permissionResolve = null;
      }
      return;
    }

    // Ctrl+C
    if (key === '\x03') {
      if (this.resolveInput) {
        // During input, just clear
        this.input.text = '';
        this.input.cursor = 0;
        this.render();
      } else if (this.abortHandler) {
        // During agent execution, abort the stream
        this.abortHandler();
        this.showInfo(theme.warning('Interrupted.'));
      }
      return;
    }

    // Ctrl+D — quit
    if (key === '\x04') {
      if (this.resolveInput) {
        this.rejectInput?.(new Error('EOF'));
        this.resolveInput = null;
        this.rejectInput = null;
      }
      return;
    }

    // Only process further if we're waiting for input
    if (!this.resolveInput) return;

    // ─── Command menu navigation ─────────────────────────────────────
    if (this.commandMenuVisible) {
      // Enter — select highlighted command or submit raw text if no match
      if (key === '\r' || key === '\n') {
        this.commandMenuVisible = false;

        if (this.filteredCommands.length > 0) {
          const selected = this.filteredCommands[this.commandMenuSelection];
          this.input.text = selected.name + (selected.args ? ' ' : '');
          this.input.cursor = this.input.text.length;

          // If command takes no args, submit immediately
          if (!selected.args) {
            this.input.history.unshift(this.input.text.trim());
            if (this.input.history.length > 100) this.input.history.pop();
            this.input.historyIdx = -1;
            const resolve = this.resolveInput;
            this.resolveInput = null;
            this.rejectInput = null;
            resolve(this.input.text.trim());
            return;
          }
        } else {
          // No matching commands — submit whatever the user typed as-is
          const text = this.input.text.trim();
          if (text) {
            this.input.history.unshift(text);
            if (this.input.history.length > 100) this.input.history.pop();
            this.input.historyIdx = -1;
            const resolve = this.resolveInput;
            this.resolveInput = null;
            this.rejectInput = null;
            resolve(text);
            return;
          }
        }
        this.render();
        return;
      }

      // Arrow up/down — navigate menu
      if (key === '\x1b[A') {
        this.commandMenuSelection = Math.max(0, this.commandMenuSelection - 1);
        this.render();
        return;
      }
      if (key === '\x1b[B') {
        this.commandMenuSelection = Math.min(this.filteredCommands.length - 1, this.commandMenuSelection + 1);
        this.render();
        return;
      }

      // Escape — close menu
      if (key === '\x1b' && data.length === 1) {
        this.commandMenuVisible = false;
        this.render();
        return;
      }

      // Tab — accept selection and keep typing
      if (key === '\t') {
        if (this.filteredCommands.length > 0) {
          const selected = this.filteredCommands[this.commandMenuSelection];
          this.input.text = selected.name + (selected.args ? ' ' : '');
          this.input.cursor = this.input.text.length;
          this.commandMenuVisible = false;
        }
        this.render();
        return;
      }

      // Backspace — if deleting past /, close menu
      if (key === '\x7f' || key === '\b') {
        if (this.input.cursor > 0) {
          this.input.text =
            this.input.text.slice(0, this.input.cursor - 1) +
            this.input.text.slice(this.input.cursor);
          this.input.cursor--;
          if (!this.input.text.startsWith('/')) {
            this.commandMenuVisible = false;
          } else {
            this.updateCommandFilter();
          }
          this.render();
        }
        return;
      }

      // Regular character — filter the menu
      if (key.length === 1 && key.charCodeAt(0) >= 32) {
        this.input.text =
          this.input.text.slice(0, this.input.cursor) +
          key +
          this.input.text.slice(this.input.cursor);
        this.input.cursor++;

        // If there's a space after the command name, close menu
        if (this.input.text.includes(' ')) {
          this.commandMenuVisible = false;
        } else {
          this.updateCommandFilter();
        }
        this.render();
        return;
      }
    }

    // ─── Normal input handling ───────────────────────────────────────

    // Shift+Enter or Alt+Enter — insert newline for multi-line input
    // Terminals send various sequences: ESC+CR, ESC+LF, CSI 13;2u (kitty), CSI 27;2;13~ (xterm)
    if (key === '\x1b\r' || key === '\x1b\n' || key === '\x1b[13;2u' || key === '\x1b[27;2;13~') {
      this.input.text =
        this.input.text.slice(0, this.input.cursor) +
        '\n' +
        this.input.text.slice(this.input.cursor);
      this.input.cursor++;
      this.render();
      return;
    }

    // Alt+Enter (some terminals send ESC followed by carriage return as two bytes)
    if (key.length === 2 && key[0] === '\x1b' && (key[1] === '\r' || key[1] === '\n')) {
      this.input.text =
        this.input.text.slice(0, this.input.cursor) +
        '\n' +
        this.input.text.slice(this.input.cursor);
      this.input.cursor++;
      this.render();
      return;
    }

    // Enter — submit (but if text has newlines and cursor isn't at end, insert newline)
    if (key === '\r' || key === '\n') {
      const text = this.input.text.trim();
      if (text) {
        this.input.history.unshift(text);
        if (this.input.history.length > 100) this.input.history.pop();
        this.input.historyIdx = -1;
        this.resolveInput(text);
        this.resolveInput = null;
        this.rejectInput = null;
      }
      return;
    }

    // Paste detection — if data is multi-char and contains newlines, insert as multi-line
    if (key.length > 1 && key.includes('\n') && !key.startsWith('\x1b')) {
      // Pasted text — insert with newlines preserved
      const cleanPaste = key.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      this.input.text =
        this.input.text.slice(0, this.input.cursor) +
        cleanPaste +
        this.input.text.slice(this.input.cursor);
      this.input.cursor += cleanPaste.length;
      this.render();
      return;
    }

    // Backspace
    if (key === '\x7f' || key === '\b') {
      if (this.input.cursor > 0) {
        this.input.text =
          this.input.text.slice(0, this.input.cursor - 1) +
          this.input.text.slice(this.input.cursor);
        this.input.cursor--;
        this.render();
      }
      return;
    }

    // Tab — show tools (when not in command menu)
    if (key === '\t') {
      this.resolveInput('/tools');
      this.resolveInput = null;
      this.rejectInput = null;
      return;
    }

    // Ctrl+P — open command menu
    if (key === '\x10') {
      this.input.text = '/';
      this.input.cursor = 1;
      this.commandMenuVisible = true;
      this.commandMenuSelection = 0;
      this.filteredCommands = [...COMMANDS];
      this.render();
      return;
    }

    // Ctrl+L — clear screen
    if (key === '\x0c') {
      this.messages = [];
      this.state = 'welcome';
      this.render();
      return;
    }

    // Scroll conversation: Shift+Up/Down or Page Up/Down
    if (key === '\x1b[1;2A' || key === '\x1b[5~') {
      // Shift+Up or Page Up — scroll up
      this.scrollOffset += (key === '\x1b[5~' ? 10 : 3);
      this.render();
      return;
    }
    if (key === '\x1b[1;2B' || key === '\x1b[6~') {
      // Shift+Down or Page Down — scroll down
      this.scrollOffset = Math.max(0, this.scrollOffset - (key === '\x1b[6~' ? 10 : 3));
      this.render();
      return;
    }

    // Arrow keys
    if (key === '\x1b[A') {
      // Up — history
      if (this.input.history.length > 0) {
        this.input.historyIdx = Math.min(this.input.historyIdx + 1, this.input.history.length - 1);
        this.input.text = this.input.history[this.input.historyIdx];
        this.input.cursor = this.input.text.length;
        this.render();
      }
      return;
    }
    if (key === '\x1b[B') {
      // Down — history forward
      if (this.input.historyIdx > 0) {
        this.input.historyIdx--;
        this.input.text = this.input.history[this.input.historyIdx];
        this.input.cursor = this.input.text.length;
      } else {
        this.input.historyIdx = -1;
        this.input.text = '';
        this.input.cursor = 0;
      }
      this.render();
      return;
    }
    if (key === '\x1b[C') {
      // Right
      this.input.cursor = Math.min(this.input.cursor + 1, this.input.text.length);
      this.render();
      return;
    }
    if (key === '\x1b[D') {
      // Left
      this.input.cursor = Math.max(this.input.cursor - 1, 0);
      this.render();
      return;
    }

    // Home / End
    if (key === '\x1b[H' || key === '\x01') {
      this.input.cursor = 0;
      this.render();
      return;
    }
    if (key === '\x1b[F' || key === '\x05') {
      this.input.cursor = this.input.text.length;
      this.render();
      return;
    }

    // Regular character
    if (key.length === 1 && key.charCodeAt(0) >= 32) {
      this.input.text =
        this.input.text.slice(0, this.input.cursor) +
        key +
        this.input.text.slice(this.input.cursor);
      this.input.cursor++;

      // Open command menu when typing / as first character
      if (key === '/' && this.input.text === '/') {
        this.commandMenuVisible = true;
        this.commandMenuSelection = 0;
        this.filteredCommands = [...COMMANDS];
      }

      this.render();
    }
  }

  /** Update the filtered command list based on current input */
  private updateCommandFilter(): void {
    const query = this.input.text.toLowerCase();
    this.filteredCommands = COMMANDS.filter(c => c.name.toLowerCase().startsWith(query));
    this.commandMenuSelection = Math.min(this.commandMenuSelection, Math.max(0, this.filteredCommands.length - 1));
  }

  // ─── Helpers ───────────────────────────────────────────────────────

  private addMessage(msg: Message): void {
    this.messages.push(msg);
    // Keep message buffer reasonable
    if (this.messages.length > 500) {
      this.messages = this.messages.slice(-400);
    }
  }
}
