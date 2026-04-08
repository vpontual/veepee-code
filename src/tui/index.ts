import React from 'react';
import { render, type Instance } from 'ink';
import { execSync } from 'child_process';
import { App, type AppHandle } from './App.js';
import { theme, icons } from './theme.js';
import type { Message, TurnTracker, CommandDef, ModelItem, PermissionOption } from './types.js';

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

export { theme, box, icons } from './theme.js';

// ─── Command Definitions (needed for filter logic) ──────────────────────────

const COMMANDS: CommandDef[] = [
  { name: '/models', args: '[name]', description: 'Browse and select models interactively' },
  { name: '/models auto', args: '', description: 'Re-enable auto model switching' },
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
  { name: '/setup wizard', args: '', description: 'Re-run the full setup wizard' },
  { name: '/setup wizard', args: '<integration>', description: 'Reconfigure one integration' },
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
  { name: '/style', args: '[name|off]', description: 'Set output style/personality' },
  { name: '/benchmark context', args: '', description: 'Probe optimal context sizes per model' },
  { name: '/shell', args: '', description: 'Enter interactive shell mode (exit to return)' },
  { name: '/sandbox', args: '', description: 'List sandbox files' },
  { name: '/sandbox keep', args: '<file> [dest]', description: 'Move sandbox file to working directory' },
  { name: '/sandbox clean', args: '', description: 'Clean sandbox directory' },
  { name: '/sandbox preview', args: '<file>', description: 'Preview a sandbox file' },
  { name: '/preview', args: '<file>', description: 'Preview/run a file' },
  { name: '/preview stop', args: '', description: 'Stop the preview server' },
  { name: '/run', args: '<file>', description: 'Run a script file (alias for /preview)' },
  { name: '/sync push', args: '[all]', description: 'Push session(s) to WebDAV' },
  { name: '/sync pull', args: '', description: 'Pull sessions from WebDAV' },
  { name: '/sync auto', args: '', description: 'Toggle auto-sync on save' },
  { name: '/sync status', args: '', description: 'Show sync configuration' },
  { name: '/rc', args: '', description: 'Show Remote Connect URL and status' },
  { name: '/rc qr', args: '', description: 'Show Remote Connect URL for phone' },
  { name: '/settings', args: '', description: 'View and toggle settings' },
  { name: '/settings progress-bar', args: '', description: 'Toggle progress bar animation' },
  { name: '/quit', args: '', description: 'Exit VEEPEE Code' },
  { name: '/exit', args: '', description: 'Exit VEEPEE Code' },
];

// ─── TUI Class ───────────────────────────────────────────────────────────────

export class TUI {
  private inkInstance: Instance | null = null;
  private appHandle: AppHandle | null = null;
  private appRef = React.createRef<AppHandle>();

  private resolveInput: ((value: string) => void) | null = null;
  private rejectInput: ((reason: Error) => void) | null = null;
  private permissionResolve: ((value: string) => void) | null = null;
  private modelSelectorResolve: ((value: { name: string; action: 'use' | 'default' } | null) => void) | null = null;
  private abortHandler: (() => void) | null = null;
  private turnTrackerInterval: ReturnType<typeof setInterval> | null = null;
  private stdinHandler: ((data: Buffer) => void) | null = null;
  private pendingDispatches: import('./types.js').AppAction[] = [];

  onTabTools: (() => void) | null = null;
  private toolsShown = false;

  constructor() {}

  // ─── Lifecycle ─────────────────────────────────────────────────────

  start(info: {
    model: string; modelSize: string; toolCount: number;
    modelCount: number; version: string; apiPort: number;
  }): void {
    // Enter alternate screen buffer (like the old code)
    process.stdout.write('\x1b[?1049h'); // switch to alternate buffer
    process.stdout.write('\x1b[?25l');   // hide cursor
    process.stdout.write('\x1b[2J');     // clear
    process.stdout.write('\x1b[H');      // home

    // No mouse tracking — let the terminal handle scroll and text selection natively.
    // Scroll in the TUI via keyboard: arrow keys, Page Up/Down, j/k.

    // Set up raw stdin for keystroke handling (bypass Ink's useInput)
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    this.stdinHandler = (data: Buffer) => this.handleKey(data.toString());
    process.stdin.on('data', this.stdinHandler);

    this.inkInstance = render(
      React.createElement(App, {
        ref: this.appRef,
      }),
      {
        exitOnCtrlC: false,
        incrementalRendering: true,
      },
    );

    // Wait for ref to be populated, then flush any queued dispatches
    const checkRef = () => {
      if (this.appRef.current) {
        this.appHandle = this.appRef.current;
        // Flush any dispatches that were queued before the ref was ready
        for (const action of this.pendingDispatches) {
          this.appHandle.dispatch(action);
        }
        this.pendingDispatches = [];
        this.dispatch({ type: 'SET_START_INFO', ...info });
      } else {
        setTimeout(checkRef, 10);
      }
    };
    checkRef();
  }

  stop(): void {
    if (this.turnTrackerInterval) clearInterval(this.turnTrackerInterval);
    // Remove raw stdin handler
    if (this.stdinHandler) {
      process.stdin.off('data', this.stdinHandler);
      this.stdinHandler = null;
    }
    process.stdin.setRawMode?.(false);
    // No mouse tracking to disable (we don't enable it)
    this.inkInstance?.unmount();
    // Restore terminal: show cursor + exit alternate screen
    process.stdout.write('\x1b[?25h');   // show cursor
    process.stdout.write('\x1b[?1049l'); // restore main buffer
  }

  // ─── Dispatch helper ──────────────────────────────────────────────

  private dispatch(action: import('./types.js').AppAction): void {
    if (this.appHandle) {
      this.appHandle.dispatch(action);
    } else {
      this.pendingDispatches.push(action);
    }
  }

  private getState(): import('./types.js').AppState | undefined {
    return this.appHandle?.getState();
  }

  // ─── Public API (same as before) ──────────────────────────────────

  setUpdateAvailable(behind: number): void {
    this.dispatch({ type: 'SET_UPDATE_AVAILABLE', behind });
  }

  getInput(_placeholder?: string): Promise<string> {
    const state = this.getState();

    // Type-ahead: move queued text into the input box for user to review/edit
    if (state && state.queuedInput.length > 0) {
      const queued = state.queuedInput;
      const cursor = state.queuedCursor;
      this.dispatch({ type: 'SET_QUEUED_INPUT', text: '', cursor: 0 });
      this.dispatch({ type: 'SET_INPUT', input: { text: queued, cursor } });
    } else {
      this.dispatch({ type: 'SET_INPUT', input: { text: '', cursor: 0 } });
    }

    this.dispatch({ type: 'SET_TOOLS_SHOWN', shown: false });
    this.dispatch({ type: 'SET_VIEW', view: state && state.messages.length > 0 ? 'conversation' : 'welcome' });
    this.dispatch({ type: 'SET_INPUT_ACTIVE', active: true });

    return new Promise((resolve, reject) => {
      this.resolveInput = resolve;
      this.rejectInput = reject;
    });
  }

  async promptPermission(toolName: string, args: Record<string, unknown>, reason?: string): Promise<string> {
    const argsSummary = Object.entries(args)
      .map(([k, v]) => {
        const val = typeof v === 'string'
          ? (v.length > 80 ? v.slice(0, 77) + '...' : v)
          : JSON.stringify(v);
        return `${theme.muted(k)}: ${val}`;
      })
      .join('  ');

    this.dispatch({
      type: 'ADD_MESSAGE',
      message: {
        role: 'system',
        content: `${theme.warning(icons.warn)} ${theme.textBold(toolName)}${reason ? theme.muted(` (${reason})`) : ''}  ${argsSummary}`,
      },
    });

    // Check if tool operates on files (offer project-scoped permission)
    const hasFilePath = args.path || args.file;
    const options: { label: string; value: string }[] = [
      { label: 'Yes', value: 'y' },
      { label: `Yes, allow ${theme.accent(toolName)} for this session`, value: 's' },
      ...(hasFilePath ? [{ label: `Yes, always in this project`, value: 'p' }] : []),
      { label: `Yes, always allow ${theme.accent(toolName)}`, value: 'a' },
      { label: 'No', value: 'n' },
    ];

    this.dispatch({
      type: 'SET_PERMISSION',
      options,
      selection: 0,
      toolName,
    });

    return new Promise((resolve) => {
      this.permissionResolve = resolve;
    });
  }

  setAbortHandler(handler: () => void): void {
    this.abortHandler = handler;
  }

  addUserMessage(content: string): void {
    this.dispatch({ type: 'ADD_MESSAGE', message: { role: 'user', content, timestamp: Date.now() } });
    this.dispatch({ type: 'SET_VIEW', view: 'waiting' });
    this.dispatch({ type: 'SET_INPUT', input: { text: '', cursor: 0 } });
    this.dispatch({ type: 'SET_SCROLL', offset: 0 });
    this.dispatch({ type: 'SET_COMMAND_MENU', visible: false });

    // Start turn tracker
    const tracker: TurnTracker = {
      startTime: Date.now(),
      toolCalls: [],
      tokensEstimate: 0,
      model: this.getState()?.modelName || '',
      active: true,
    };
    this.dispatch({ type: 'SET_TURN_TRACKER', tracker });

    if (this.turnTrackerInterval) clearInterval(this.turnTrackerInterval);
    this.turnTrackerInterval = setInterval(() => {
      // Trigger a re-render by dispatching a no-op-like action
      // The TurnTracker component handles its own timer
    }, 500);
  }

  addCommandMessage(content: string): void {
    this.dispatch({ type: 'ADD_MESSAGE', message: { role: 'user', content, timestamp: Date.now() } });
    this.dispatch({ type: 'SET_VIEW', view: 'conversation' });
    this.dispatch({ type: 'SET_INPUT', input: { text: '', cursor: 0 } });
    this.dispatch({ type: 'SET_SCROLL', offset: 0 });
    this.dispatch({ type: 'SET_COMMAND_MENU', visible: false });
  }

  startStream(): void {
    this.dispatch({ type: 'START_STREAM' });
  }

  appendStream(text: string): void {
    this.dispatch({ type: 'APPEND_STREAM', text });
  }

  endStream(): void {
    this.dispatch({ type: 'END_STREAM' });
  }

  showToolCall(name: string, args: Record<string, unknown>): void {
    // Keep progress bar bouncing during tool execution
    this.dispatch({ type: 'SET_PROGRESS_BAR_ACTIVE', active: true });
    const argsStr = Object.entries(args)
      .map(([k, v]) => {
        const val = typeof v === 'string'
          ? (v.length > 60 ? v.slice(0, 57) + '...' : v)
          : JSON.stringify(v);
        return `${k}=${val}`;
      })
      .join(' ');
    this.dispatch({ type: 'ADD_MESSAGE', message: { role: 'tool_call', content: `${name} ${argsStr}` } });
    this.dispatch({ type: 'ADD_TOOL_CALL', name });
  }

  showToolResult(name: string, success: boolean, output: string): void {
    const lines = output.split('\n');
    const preview = lines.length > 3
      ? lines.slice(0, 3).join('\n') + `\n... (${lines.length - 3} more lines)`
      : output;
    this.dispatch({ type: 'ADD_MESSAGE', message: { role: 'tool_result', content: preview, success, meta: name } });
    this.dispatch({
      type: 'UPDATE_TOOL_CALL',
      name,
      status: success ? 'done' : 'error',
      elapsed: Date.now() - (this.getState()?.turnTracker?.startTime || Date.now()),
      tokensEstimate: Math.ceil(output.length / 4),
    });
  }

  showModelSwitch(from: string, to: string): void {
    this.dispatch({ type: 'SET_MODEL', name: to });
    this.dispatch({
      type: 'ADD_MESSAGE',
      message: { role: 'model_switch', content: `${from} ${icons.arrow} ${to}` },
    });
  }

  showPermissionDenied(name: string): void {
    this.dispatch({
      type: 'ADD_MESSAGE',
      message: { role: 'system', content: `${icons.lock} ${name} — skipped (denied)` },
    });
  }

  showThinking(content: string): void {
    if (content === '...') {
      const state = this.getState();
      const lastMsg = state?.messages[state.messages.length - 1];
      if (lastMsg?.role === 'thinking' && lastMsg.content === '...') return;
      this.dispatch({ type: 'ADD_MESSAGE', message: { role: 'thinking', content: '...', collapsed: true } });
      return;
    }
    this.dispatch({ type: 'REPLACE_LAST_THINKING', message: { role: 'thinking', content, collapsed: true } });
  }

  showModelSelector(
    models: Array<{ name: string; parameterSize: string; score: number; tier: string; capabilities: string[] }>,
    currentModel: string,
  ): Promise<{ name: string; action: 'use' | 'default' } | null> {
    const items: ModelItem[] = models.map(m => ({
      name: m.name,
      size: m.parameterSize,
      score: m.score,
      tier: m.tier,
      active: m.name === currentModel,
      caps: m.capabilities,
    }));
    const activeIdx = items.findIndex(m => m.active);

    this.dispatch({
      type: 'SET_MODEL_SELECTOR',
      active: true,
      items,
      index: activeIdx >= 0 ? activeIdx : 0,
    });

    return new Promise(resolve => {
      this.modelSelectorResolve = resolve;
    });
  }

  setModelList(models: Array<{ name: string; parameterSize: string }>): void {
    this.dispatch({
      type: 'SET_MODEL_LIST',
      models: models.map(m => ({ name: m.name, size: m.parameterSize })),
    });
  }

  showError(msg: string): void {
    // Stop turn tracker (same cleanup as showCompletionBadge — error path skips that)
    const state = this.getState();
    if (state?.turnTracker) {
      this.dispatch({ type: 'SET_TURN_TRACKER', tracker: { ...state.turnTracker, active: false } });
    }
    if (this.turnTrackerInterval) {
      clearInterval(this.turnTrackerInterval);
      this.turnTrackerInterval = null;
    }
    this.dispatch({ type: 'SET_TURN_TRACKER', tracker: null });
    this.dispatch({ type: 'SET_PROGRESS_BAR_ACTIVE', active: false });
    this.dispatch({ type: 'ADD_MESSAGE', message: { role: 'system', content: `${theme.error(msg)}` } });
    this.dispatch({ type: 'SET_VIEW', view: 'conversation' });
  }

  showInfo(msg: string): void {
    this.dispatch({ type: 'ADD_MESSAGE', message: { role: 'system', content: msg } });
    const state = this.getState();
    if (state?.view === 'welcome' && state.messages.length > 0) {
      this.dispatch({ type: 'SET_VIEW', view: 'conversation' });
    }
  }

  /** Copy the last assistant response to system clipboard */
  copyLastResponse(): void {
    const state = this.getState();
    if (!state) return;

    const lastAssistant = [...state.messages].reverse().find(m => m.role === 'assistant');
    if (!lastAssistant?.content) {
      this.showInfo(theme.dim('Nothing to copy.'));
      return;
    }

    const text = lastAssistant.content;
    // Try platform clipboard tools
    // execSync imported at top of file
    try {
      if (process.platform === 'darwin') {
        execSync('pbcopy', { input: text, stdio: ['pipe', 'pipe', 'pipe'] });
      } else if (process.platform === 'linux') {
        // Try wl-copy (Wayland) first, then xclip (X11)
        try {
          execSync('wl-copy', { input: text, stdio: ['pipe', 'pipe', 'pipe'] });
        } catch {
          execSync('xclip -selection clipboard', { input: text, stdio: ['pipe', 'pipe', 'pipe'] });
        }
      }
      this.showInfo(theme.success(`Copied ${text.length} chars to clipboard.`));
    } catch {
      this.showInfo(theme.error('No clipboard tool available (install wl-copy or xclip).'));
    }
  }

  updateStats(tokens: number, percent: number, messages: number, elapsed: number): void {
    this.dispatch({ type: 'SET_STATS', tokens, percent, messages, elapsed });
  }

  setProgressBar(enabled: boolean): void {
    this.dispatch({ type: 'SET_PROGRESS_BAR', enabled });
  }

  getProgressBar(): boolean {
    return this.getState()?.progressBarEnabled ?? true;
  }

  updateModel(name: string, size?: string, role?: string): void {
    this.dispatch({ type: 'SET_MODEL', name, size, role });
  }

  showCompletionBadge(model: string, elapsed: number, metrics?: { evalCount?: number; promptEvalCount?: number; tokensPerSecond?: number }): void {
    // Stop turn tracker
    const state = this.getState();
    if (state?.turnTracker) {
      this.dispatch({ type: 'SET_TURN_TRACKER', tracker: { ...state.turnTracker, active: false } });
    }
    if (this.turnTrackerInterval) {
      clearInterval(this.turnTrackerInterval);
      this.turnTrackerInterval = null;
    }

    const secs = (elapsed / 1000).toFixed(1);
    const toolCount = state?.turnTracker?.toolCalls.length || 0;
    const evalTokens = metrics?.evalCount || state?.turnTracker?.tokensEstimate || 0;
    const promptTokens = metrics?.promptEvalCount || 0;
    const tps = metrics?.tokensPerSecond || 0;

    const tokStr = evalTokens > 1000 ? `${(evalTokens / 1000).toFixed(1)}k` : String(evalTokens);
    const promptStr = promptTokens > 0 ? ` ${icons.dot} ${promptTokens > 1000 ? `${(promptTokens / 1000).toFixed(1)}k` : promptTokens} prompt` : '';
    const tpsStr = tps > 0 ? ` ${icons.dot} ${tps} tok/s` : '';
    const modelRole = state?.modelRole || 'Act';

    this.dispatch({
      type: 'ADD_MESSAGE',
      message: {
        role: 'system',
        content: `${theme.muted(`${icons.toolDone}  ${modelRole} ${icons.dot} ${model} ${icons.dot} ${toolCount} tool calls ${icons.dot} ${tokStr} tokens${promptStr}${tpsStr} ${icons.dot} ${secs}s`)}`,
      },
    });

    this.dispatch({ type: 'SET_TURN_TRACKER', tracker: null });
    this.dispatch({ type: 'SET_PROGRESS_BAR_ACTIVE', active: false });
    this.dispatch({ type: 'SET_VIEW', view: 'conversation' });
  }

  /** Needed by src/index.ts for benchmark progress — direct access to messages array */
  get messages(): Message[] {
    return this.getState()?.messages || [];
  }

  /** Force re-render — triggers a state update to make React re-render.
   *  Needed for code that directly mutates the messages array (e.g. benchmark progress). */
  render(): void {
    this.dispatch({ type: 'FORCE_RENDER' });
  }

  // ─── Input Handling ────────────────────────────────────────────────

  private handleKey(raw: string): void {
    const key = raw;
    const state = this.getState();
    if (!state) return;

    // Model selector mode
    if (state.modelSelectorActive && this.modelSelectorResolve) {
      if (key === '\x1b[A' || key === '\x1bOA' || key === 'k') {
        this.dispatch({ type: 'SET_MODEL_SELECTOR', active: true, index: Math.max(0, state.modelSelectorIndex - 1) });
        return;
      }
      if (key === '\x1b[B' || key === '\x1bOB' || key === 'j') {
        this.dispatch({ type: 'SET_MODEL_SELECTOR', active: true, index: Math.min(state.modelSelectorItems.length - 1, state.modelSelectorIndex + 1) });
        return;
      }
      if (key === '\r' || key === '\n') {
        const selected = state.modelSelectorItems[state.modelSelectorIndex];
        this.dispatch({ type: 'ADD_MESSAGE', message: { role: 'system', content: theme.dim(`  ${icons.arrow} Using ${selected.name} for this session`) } });
        this.dispatch({ type: 'SET_MODEL_SELECTOR', active: false });
        this.modelSelectorResolve({ name: selected.name, action: 'use' });
        this.modelSelectorResolve = null;
        return;
      }
      if (key === ' ') {
        const selected = state.modelSelectorItems[state.modelSelectorIndex];
        this.dispatch({ type: 'ADD_MESSAGE', message: { role: 'system', content: theme.dim(`  ${icons.arrow} Set ${selected.name} as default`) } });
        this.dispatch({ type: 'SET_MODEL_SELECTOR', active: false });
        this.modelSelectorResolve({ name: selected.name, action: 'default' });
        this.modelSelectorResolve = null;
        return;
      }
      if (key === '\x1b' || key === '\x03') {
        this.dispatch({ type: 'SET_MODEL_SELECTOR', active: false });
        this.modelSelectorResolve(null);
        this.modelSelectorResolve = null;
        return;
      }
      return;
    }

    // Mouse events are not tracked — terminal handles scroll and selection natively.
    // Ignore any stray mouse escape sequences.
    if (key.match(/\x1b\[<\d+;\d+;\d+[Mm]/)) return;

    // Permission prompt mode
    if (this.permissionResolve) {
      if (key === '\x1b[A') {
        this.dispatch({ type: 'SET_PERMISSION', options: state.permissionOptions, selection: Math.max(0, state.permissionMenuSelection - 1) });
        return;
      }
      if (key === '\x1b[B') {
        this.dispatch({ type: 'SET_PERMISSION', options: state.permissionOptions, selection: Math.min(state.permissionOptions.length - 1, state.permissionMenuSelection + 1) });
        return;
      }
      if (key === '\r' || key === '\n') {
        const selected = state.permissionOptions[state.permissionMenuSelection];
        this.dispatch({ type: 'ADD_MESSAGE', message: { role: 'system', content: theme.dim(`  ${icons.arrow} ${stripAnsi(selected.label)}`) } });
        this.permissionResolve(selected.value);
        this.permissionResolve = null;
        this.dispatch({ type: 'CLEAR_PERMISSION' });
        return;
      }
      if (key === 'y' || key === 'Y') {
        this.dispatch({ type: 'ADD_MESSAGE', message: { role: 'system', content: theme.dim(`  ${icons.arrow} Yes`) } });
        this.permissionResolve('y');
        this.permissionResolve = null;
        this.dispatch({ type: 'CLEAR_PERMISSION' });
        return;
      }
      if (key === 's' || key === 'S') {
        this.dispatch({ type: 'ADD_MESSAGE', message: { role: 'system', content: theme.dim(`  ${icons.arrow} Allow for this session`) } });
        this.permissionResolve('s');
        this.permissionResolve = null;
        this.dispatch({ type: 'CLEAR_PERMISSION' });
        return;
      }
      if (key === 'p' || key === 'P') {
        this.dispatch({ type: 'ADD_MESSAGE', message: { role: 'system', content: theme.dim(`  ${icons.arrow} Always allow in this project`) } });
        this.permissionResolve('p');
        this.permissionResolve = null;
        this.dispatch({ type: 'CLEAR_PERMISSION' });
        return;
      }
      if (key === 'a' || key === 'A') {
        this.dispatch({ type: 'ADD_MESSAGE', message: { role: 'system', content: theme.dim(`  ${icons.arrow} Always allow ${state.permissionToolName}`) } });
        this.permissionResolve('a');
        this.permissionResolve = null;
        this.dispatch({ type: 'CLEAR_PERMISSION' });
        return;
      }
      if (key === 'n' || key === 'N' || key === '\x1b') {
        this.dispatch({ type: 'ADD_MESSAGE', message: { role: 'system', content: theme.dim(`  ${icons.arrow} No`) } });
        this.permissionResolve('n');
        this.permissionResolve = null;
        this.dispatch({ type: 'CLEAR_PERMISSION' });
        return;
      }
      return;
    }

    // Ctrl+Y — copy last response to clipboard
    if (key === '\x19') {
      this.copyLastResponse();
      return;
    }

    // Ctrl+C
    if (key === '\x03') {
      if (this.resolveInput) {
        this.dispatch({ type: 'SET_INPUT', input: { text: '', cursor: 0 } });
      } else if (this.abortHandler) {
        this.abortHandler();
        this.showInfo(theme.warning('Interrupted.'));
      }
      return;
    }

    // Ctrl+D
    if (key === '\x04') {
      if (this.resolveInput) {
        this.dispatch({ type: 'SET_INPUT_ACTIVE', active: false });
        this.rejectInput?.(new Error('EOF'));
        this.resolveInput = null;
        this.rejectInput = null;
      }
      return;
    }

    // Type-ahead when agent is running
    if (!this.resolveInput) {
      this.handleQueuedInput(key);
      return;
    }

    // Command menu navigation
    if (state.commandMenuVisible) {
      if (key === '\r' || key === '\n') {
        this.dispatch({ type: 'SET_COMMAND_MENU', visible: false });
        if (state.filteredCommands.length > 0) {
          const selected = state.filteredCommands[state.commandMenuSelection];
          const newText = selected.name + (selected.args ? ' ' : '');
          this.dispatch({ type: 'SET_INPUT', input: { text: newText, cursor: newText.length } });
          if (!selected.args) {
            this.submitInput(newText.trim());
            return;
          }
        } else {
          const text = state.input.text.trim();
          if (text) { this.submitInput(text); return; }
        }
        return;
      }
      if (key === '\x1b[A') {
        this.dispatch({ type: 'SET_COMMAND_MENU', visible: true, selection: Math.max(0, state.commandMenuSelection - 1) });
        return;
      }
      if (key === '\x1b[B') {
        this.dispatch({ type: 'SET_COMMAND_MENU', visible: true, selection: Math.min(state.filteredCommands.length - 1, state.commandMenuSelection + 1) });
        return;
      }
      if (key === '\x1b') {
        this.dispatch({ type: 'SET_COMMAND_MENU', visible: false });
        return;
      }
      if (key === '\t') {
        if (state.filteredCommands.length > 0) {
          const selected = state.filteredCommands[state.commandMenuSelection];
          const newText = selected.name + (selected.args ? ' ' : '');
          this.dispatch({ type: 'SET_INPUT', input: { text: newText, cursor: newText.length } });
          this.dispatch({ type: 'SET_COMMAND_MENU', visible: false });
        }
        return;
      }
      if (key === '\x7f' || key === '\b') {
        if (state.input.cursor > 0) {
          const newText = state.input.text.slice(0, state.input.cursor - 1) + state.input.text.slice(state.input.cursor);
          this.dispatch({ type: 'SET_INPUT', input: { text: newText, cursor: state.input.cursor - 1 } });
          if (!newText.startsWith('/')) {
            this.dispatch({ type: 'SET_COMMAND_MENU', visible: false });
          } else {
            this.updateCommandFilter(newText);
          }
        }
        return;
      }
      if (key.length === 1 && key.charCodeAt(0) >= 32) {
        const newText = state.input.text.slice(0, state.input.cursor) + key + state.input.text.slice(state.input.cursor);
        this.dispatch({ type: 'SET_INPUT', input: { text: newText, cursor: state.input.cursor + 1 } });
        if (newText.includes(' ')) {
          this.dispatch({ type: 'SET_COMMAND_MENU', visible: false });
          this.updateCommandFilter(newText);
        } else {
          this.updateCommandFilter(newText);
        }
        return;
      }
    }

    // Model completion menu
    if (state.modelCompletionVisible) {
      if (key === '\r' || key === '\n') {
        if (state.modelCompletionItems.length > 0) {
          const selected = state.modelCompletionItems[state.modelCompletionSelection];
          const newText = `/models ${selected.name}`;
          this.dispatch({ type: 'SET_INPUT', input: { text: newText, cursor: newText.length } });
          this.dispatch({ type: 'SET_MODEL_COMPLETION', visible: false });
          this.submitInput(newText.trim());
        }
        return;
      }
      if (key === '\x1b[A') {
        this.dispatch({ type: 'SET_MODEL_COMPLETION', visible: true, selection: Math.max(0, state.modelCompletionSelection - 1) });
        return;
      }
      if (key === '\x1b[B') {
        this.dispatch({ type: 'SET_MODEL_COMPLETION', visible: true, selection: Math.min(state.modelCompletionItems.length - 1, state.modelCompletionSelection + 1) });
        return;
      }
      if (key === '\x1b') {
        this.dispatch({ type: 'SET_MODEL_COMPLETION', visible: false });
        return;
      }
      if (key === '\t') {
        if (state.modelCompletionItems.length > 0) {
          const selected = state.modelCompletionItems[state.modelCompletionSelection];
          const newText = `/models ${selected.name}`;
          this.dispatch({ type: 'SET_INPUT', input: { text: newText, cursor: newText.length } });
          this.dispatch({ type: 'SET_MODEL_COMPLETION', visible: false });
        }
        return;
      }
      if (key === '\x7f' || key === '\b') {
        if (state.input.cursor > 0) {
          const newText = state.input.text.slice(0, state.input.cursor - 1) + state.input.text.slice(state.input.cursor);
          this.dispatch({ type: 'SET_INPUT', input: { text: newText, cursor: state.input.cursor - 1 } });
          this.updateCommandFilter(newText);
        }
        return;
      }
      if (key.length === 1 && key.charCodeAt(0) >= 32) {
        const newText = state.input.text.slice(0, state.input.cursor) + key + state.input.text.slice(state.input.cursor);
        this.dispatch({ type: 'SET_INPUT', input: { text: newText, cursor: state.input.cursor + 1 } });
        this.dispatch({ type: 'SET_MODEL_COMPLETION', visible: true, selection: 0 });
        this.updateCommandFilter(newText);
        return;
      }
    }

    // ─── Normal input handling ───────────────────────────────────────

    // Shift+Enter / Alt+Enter
    if (key === '\x1b\r' || key === '\x1b\n' || key === '\x1b[13;2u' || key === '\x1b[27;2;13~') {
      const newText = state.input.text.slice(0, state.input.cursor) + '\n' + state.input.text.slice(state.input.cursor);
      this.dispatch({ type: 'SET_INPUT', input: { text: newText, cursor: state.input.cursor + 1 } });
      return;
    }

    // Alt+Enter (two-byte)
    if (key.length === 2 && key[0] === '\x1b' && (key[1] === '\r' || key[1] === '\n')) {
      const newText = state.input.text.slice(0, state.input.cursor) + '\n' + state.input.text.slice(state.input.cursor);
      this.dispatch({ type: 'SET_INPUT', input: { text: newText, cursor: state.input.cursor + 1 } });
      return;
    }

    // Enter
    if (key === '\r' || key === '\n') {
      if (state.modelCompletionVisible && state.modelCompletionItems.length > 0) {
        const selected = state.modelCompletionItems[state.modelCompletionSelection];
        const newText = `/models ${selected.name}`;
        this.dispatch({ type: 'SET_INPUT', input: { text: newText, cursor: newText.length } });
        this.dispatch({ type: 'SET_MODEL_COMPLETION', visible: false });
        // Submit the model command directly (state hasn't updated yet)
        this.submitInput(newText.trim());
        return;
      }
      const text = state.input.text.trim();
      if (text) {
        this.submitInput(text);
      }
      return;
    }

    // Paste detection
    if (key.length > 1 && key.includes('\n') && !key.startsWith('\x1b')) {
      const cleanPaste = key.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      const newText = state.input.text.slice(0, state.input.cursor) + cleanPaste + state.input.text.slice(state.input.cursor);
      this.dispatch({ type: 'SET_INPUT', input: { text: newText, cursor: state.input.cursor + cleanPaste.length } });
      return;
    }

    // Backspace
    if (key === '\x7f' || key === '\b') {
      if (state.input.cursor > 0) {
        const newText = state.input.text.slice(0, state.input.cursor - 1) + state.input.text.slice(state.input.cursor);
        this.dispatch({ type: 'SET_INPUT', input: { text: newText, cursor: state.input.cursor - 1 } });
        this.updateCommandFilter(newText);
      }
      return;
    }

    // Tab
    if (key === '\t') {
      if (state.modelCompletionVisible && state.modelCompletionItems.length > 0) {
        const selected = state.modelCompletionItems[state.modelCompletionSelection];
        const newText = `/models ${selected.name}`;
        this.dispatch({ type: 'SET_INPUT', input: { text: newText, cursor: newText.length } });
        this.dispatch({ type: 'SET_MODEL_COMPLETION', visible: false });
      } else if (this.toolsShown) {
        this.dispatch({ type: 'POP_MESSAGE' });
        this.toolsShown = false;
      } else if (this.onTabTools) {
        this.toolsShown = true;
        this.onTabTools();
      }
      return;
    }

    // Ctrl+P — command menu
    if (key === '\x10') {
      this.dispatch({ type: 'SET_INPUT', input: { text: '/', cursor: 1 } });
      this.dispatch({ type: 'SET_COMMAND_MENU', visible: true, selection: 0, filtered: [...COMMANDS] });
      return;
    }

    // Ctrl+L — clear
    if (key === '\x0c') {
      this.dispatch({ type: 'CLEAR_MESSAGES' });
      return;
    }

    // Scroll: Shift+Up/Down, Page Up/Down
    if (key === '\x1b[1;2A' || key === '\x1b[5~') {
      const amount = key === '\x1b[5~' ? 10 : 3;
      this.dispatch({ type: 'SCROLL_UP', amount });
      return;
    }
    if (key === '\x1b[1;2B' || key === '\x1b[6~') {
      const amount = key === '\x1b[6~' ? 10 : 3;
      this.dispatch({ type: 'SCROLL_DOWN', amount });
      return;
    }

    // Arrow Up
    if (key === '\x1b[A') {
      if (state.modelCompletionVisible) {
        this.dispatch({ type: 'SET_MODEL_COMPLETION', visible: true, selection: Math.max(0, state.modelCompletionSelection - 1) });
        return;
      }
      if (state.input.history.length > 0) {
        const newIdx = Math.min(state.input.historyIdx + 1, state.input.history.length - 1);
        const histText = state.input.history[newIdx];
        this.dispatch({ type: 'SET_INPUT', input: { text: histText, cursor: histText.length, historyIdx: newIdx } });
      }
      return;
    }

    // Arrow Down
    if (key === '\x1b[B') {
      if (state.modelCompletionVisible) {
        this.dispatch({ type: 'SET_MODEL_COMPLETION', visible: true, selection: Math.min(state.modelCompletionItems.length - 1, state.modelCompletionSelection + 1) });
        return;
      }
      if (state.input.historyIdx > 0) {
        const newIdx = state.input.historyIdx - 1;
        const histText = state.input.history[newIdx];
        this.dispatch({ type: 'SET_INPUT', input: { text: histText, cursor: histText.length, historyIdx: newIdx } });
      } else {
        this.dispatch({ type: 'SET_INPUT', input: { text: '', cursor: 0, historyIdx: -1 } });
      }
      return;
    }

    // Arrow Right
    if (key === '\x1b[C') {
      this.dispatch({ type: 'SET_INPUT', input: { cursor: Math.min(state.input.cursor + 1, state.input.text.length) } });
      return;
    }

    // Arrow Left
    if (key === '\x1b[D') {
      this.dispatch({ type: 'SET_INPUT', input: { cursor: Math.max(state.input.cursor - 1, 0) } });
      return;
    }

    // Home / Ctrl+A
    if (key === '\x1b[H' || key === '\x01') {
      this.dispatch({ type: 'SET_INPUT', input: { cursor: 0 } });
      return;
    }

    // End / Ctrl+E
    if (key === '\x1b[F' || key === '\x05') {
      this.dispatch({ type: 'SET_INPUT', input: { cursor: state.input.text.length } });
      return;
    }

    // Regular character (exclude DEL 0x7f — caught by backspace above)
    if (key.length === 1 && key.charCodeAt(0) >= 32 && key.charCodeAt(0) !== 127) {
      const newText = state.input.text.slice(0, state.input.cursor) + key + state.input.text.slice(state.input.cursor);
      this.dispatch({ type: 'SET_INPUT', input: { text: newText, cursor: state.input.cursor + 1 } });

      if (key === '/' && newText === '/') {
        this.dispatch({ type: 'SET_COMMAND_MENU', visible: true, selection: 0, filtered: [...COMMANDS] });
      } else {
        this.updateCommandFilter(newText);
      }
    }
  }

  private handleQueuedInput(key: string): void {
    const state = this.getState();
    if (!state) return;

    // Backspace (must be checked before printable — 0x7f is > 32)
    if (key === '\x7f' || key === '\b') {
      if (state.queuedCursor > 0) {
        const newText = state.queuedInput.slice(0, state.queuedCursor - 1) + state.queuedInput.slice(state.queuedCursor);
        this.dispatch({ type: 'SET_QUEUED_INPUT', text: newText, cursor: state.queuedCursor - 1 });
      }
      return;
    }

    // Regular printable character (exclude DEL 0x7f)
    if (key.length === 1 && key.charCodeAt(0) >= 32 && key.charCodeAt(0) !== 127) {
      const newText = state.queuedInput.slice(0, state.queuedCursor) + key + state.queuedInput.slice(state.queuedCursor);
      this.dispatch({ type: 'SET_QUEUED_INPUT', text: newText, cursor: state.queuedCursor + 1 });
      return;
    }

    // Newlines
    if (key === '\x1b\r' || key === '\x1b\n' || key === '\x1b[13;2u' || key === '\x1b[27;2;13~') {
      const newText = state.queuedInput.slice(0, state.queuedCursor) + '\n' + state.queuedInput.slice(state.queuedCursor);
      this.dispatch({ type: 'SET_QUEUED_INPUT', text: newText, cursor: state.queuedCursor + 1 });
      return;
    }

    // Left/Right arrows
    if (key === '\x1b[C') {
      this.dispatch({ type: 'SET_QUEUED_INPUT', text: state.queuedInput, cursor: Math.min(state.queuedCursor + 1, state.queuedInput.length) });
      return;
    }
    if (key === '\x1b[D') {
      this.dispatch({ type: 'SET_QUEUED_INPUT', text: state.queuedInput, cursor: Math.max(state.queuedCursor - 1, 0) });
      return;
    }

    // Paste detection
    if (key.length > 1 && key.includes('\n') && !key.startsWith('\x1b')) {
      const cleanPaste = key.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      const newText = state.queuedInput.slice(0, state.queuedCursor) + cleanPaste + state.queuedInput.slice(state.queuedCursor);
      this.dispatch({ type: 'SET_QUEUED_INPUT', text: newText, cursor: state.queuedCursor + cleanPaste.length });
    }
  }

  private submitInput(text: string): void {
    const state = this.getState();
    if (!state) return;

    this.toolsShown = false;
    const history = [...state.input.history];
    history.unshift(text);
    if (history.length > 100) history.pop();
    this.dispatch({ type: 'SET_INPUT', input: { history, historyIdx: -1 } });
    this.dispatch({ type: 'SET_INPUT_ACTIVE', active: false });

    if (this.resolveInput) {
      const resolve = this.resolveInput;
      this.resolveInput = null;
      this.rejectInput = null;
      resolve(text);
    }
  }

  private updateCommandFilter(text?: string): void {
    const state = this.getState();
    if (!state) return;
    const query = (text || state.input.text).toLowerCase();

    // Check model name completion
    const modelMatch = query.match(/^\/models?\s+(.*)$/);
    if (modelMatch && state.allModelNames.length > 0) {
      const partial = modelMatch[1];
      this.dispatch({ type: 'SET_COMMAND_MENU', visible: false });
      const items = partial
        ? state.allModelNames.filter(m => m.name.toLowerCase().includes(partial))
        : [...state.allModelNames];
      this.dispatch({
        type: 'SET_MODEL_COMPLETION',
        visible: items.length > 0,
        items,
        selection: Math.min(state.modelCompletionSelection, Math.max(0, items.length - 1)),
      });
      return;
    }

    this.dispatch({ type: 'SET_MODEL_COMPLETION', visible: false });
    const filtered = COMMANDS.filter(c => c.name.toLowerCase().startsWith(query));
    this.dispatch({
      type: 'SET_COMMAND_MENU',
      visible: state.commandMenuVisible,
      filtered,
      selection: Math.min(state.commandMenuSelection, Math.max(0, filtered.length - 1)),
    });
  }
}
