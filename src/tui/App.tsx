import React, { useReducer, useImperativeHandle, forwardRef } from 'react';
import { useStdout, useInput } from 'ink';
import { WelcomeScreen } from './components/WelcomeScreen.js';
import { Conversation } from './components/Conversation.js';
import { ProgressBar } from './components/ProgressBar.js';
import type { AppState, AppAction, CommandDef } from './types.js';

// ─── Command Definitions ─────────────────────────────────────────────────────

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
  { name: '/setup wizard', args: '<integration>', description: 'Reconfigure one integration (proxy, searxng, remote, etc.)' },
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
  { name: '/shell', args: '', description: 'Enter interactive shell mode (exit to return)' },
  { name: '/sandbox', args: '', description: 'List sandbox files' },
  { name: '/sandbox keep', args: '<file> [dest]', description: 'Move sandbox file to working directory' },
  { name: '/sandbox clean', args: '', description: 'Clean sandbox directory' },
  { name: '/sandbox preview', args: '<file>', description: 'Preview a sandbox file' },
  { name: '/preview', args: '<file>', description: 'Preview/run a file (HTML served, scripts executed)' },
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

// ─── Initial State ───────────────────────────────────────────────────────────

const initialState: AppState = {
  view: 'welcome',
  messages: [],
  input: { text: '', cursor: 0, history: [], historyIdx: -1 },
  scrollOffset: 0,
  modelName: '',
  modelSize: '',
  modelRole: 'Act',
  providerName: 'Ollama Fleet',
  toolCount: 0,
  modelCount: 0,
  tokenCount: 0,
  tokenPercent: 0,
  messageCount: 0,
  elapsed: 0,
  version: '0.1.0',
  apiPort: 8484,
  streamBuffer: '',
  streamActive: false,
  progressBarActive: false,
  turnTracker: null,
  progressBarEnabled: true,
  updateAvailable: null,
  commandMenuVisible: false,
  commandMenuSelection: 0,
  filteredCommands: [],
  modelCompletionVisible: false,
  modelCompletionItems: [],
  modelCompletionSelection: 0,
  modelSelectorActive: false,
  modelSelectorItems: [],
  modelSelectorIndex: 0,
  permissionOptions: [],
  permissionMenuSelection: 0,
  permissionToolName: '',
  queuedInput: '',
  queuedCursor: 0,
  toolsShown: false,
  allModelNames: [],
  renderTick: 0,
  inputActive: false,
};

// ─── Reducer ─────────────────────────────────────────────────────────────────

function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'SET_VIEW':
      return { ...state, view: action.view };

    case 'ADD_MESSAGE': {
      const messages = [...state.messages, action.message];
      // Keep buffer reasonable
      if (messages.length > 500) {
        return { ...state, messages: messages.slice(-400) };
      }
      return { ...state, messages };
    }

    case 'REPLACE_LAST_THINKING': {
      const msgs = [...state.messages];
      const lastIdx = msgs.findLastIndex(m => m.role === 'thinking');
      if (lastIdx >= 0) {
        msgs[lastIdx] = action.message;
      } else {
        msgs.push(action.message);
      }
      return { ...state, messages: msgs };
    }

    case 'POP_MESSAGE':
      return { ...state, messages: state.messages.slice(0, -1) };

    case 'SET_INPUT':
      return { ...state, input: { ...state.input, ...action.input } };

    case 'SET_SCROLL':
      return { ...state, scrollOffset: action.offset };

    case 'SCROLL_UP':
      return { ...state, scrollOffset: state.scrollOffset + action.amount };

    case 'SCROLL_DOWN':
      return { ...state, scrollOffset: Math.max(0, state.scrollOffset - action.amount) };

    case 'SET_MODEL':
      return {
        ...state,
        modelName: action.name,
        ...(action.size ? { modelSize: action.size } : {}),
        ...(action.role ? { modelRole: action.role } : {}),
      };

    case 'SET_STATS':
      return {
        ...state,
        tokenCount: action.tokens,
        tokenPercent: action.percent,
        messageCount: action.messages,
        elapsed: action.elapsed,
      };

    case 'START_STREAM':
      return { ...state, streamBuffer: '', streamActive: true, progressBarActive: true };

    case 'APPEND_STREAM':
      return { ...state, streamBuffer: state.streamBuffer + action.text };

    case 'END_STREAM': {
      const newMsgs = [...state.messages];
      if (state.streamBuffer.trim()) {
        newMsgs.push({ role: 'assistant', content: state.streamBuffer.trim() });
        if (newMsgs.length > 500) newMsgs.splice(0, newMsgs.length - 400);
      }
      return { ...state, streamBuffer: '', streamActive: false, progressBarActive: false, view: 'conversation', messages: newMsgs };
    }

    case 'SET_PROGRESS_BAR_ACTIVE':
      return { ...state, progressBarActive: action.active };

    case 'SET_TURN_TRACKER':
      return { ...state, turnTracker: action.tracker };

    case 'ADD_TOOL_CALL': {
      if (!state.turnTracker) return state;
      const tracker = {
        ...state.turnTracker,
        toolCalls: [...state.turnTracker.toolCalls, { name: action.name, status: 'running' as const }],
      };
      return { ...state, turnTracker: tracker };
    }

    case 'UPDATE_TOOL_CALL': {
      if (!state.turnTracker) return state;
      const calls = [...state.turnTracker.toolCalls];
      const tc = [...calls].reverse().find(t => t.name === action.name && t.status === 'running');
      if (tc) {
        tc.status = action.status;
        tc.elapsed = action.elapsed;
      }
      const tokensEstimate = state.turnTracker.tokensEstimate + (action.tokensEstimate || 0);
      return { ...state, turnTracker: { ...state.turnTracker, toolCalls: calls, tokensEstimate } };
    }

    case 'SET_PROGRESS_BAR':
      return { ...state, progressBarEnabled: action.enabled };

    case 'SET_UPDATE_AVAILABLE':
      return { ...state, updateAvailable: { behind: action.behind } };

    case 'SET_COMMAND_MENU':
      return {
        ...state,
        commandMenuVisible: action.visible,
        ...(action.selection !== undefined ? { commandMenuSelection: action.selection } : {}),
        ...(action.filtered !== undefined ? { filteredCommands: action.filtered } : {}),
      };

    case 'SET_MODEL_COMPLETION':
      return {
        ...state,
        modelCompletionVisible: action.visible,
        ...(action.items !== undefined ? { modelCompletionItems: action.items } : {}),
        ...(action.selection !== undefined ? { modelCompletionSelection: action.selection } : {}),
      };

    case 'SET_MODEL_SELECTOR':
      return {
        ...state,
        modelSelectorActive: action.active,
        ...(action.items !== undefined ? { modelSelectorItems: action.items } : {}),
        ...(action.index !== undefined ? { modelSelectorIndex: action.index } : {}),
      };

    case 'SET_PERMISSION':
      return {
        ...state,
        permissionOptions: action.options,
        ...(action.selection !== undefined ? { permissionMenuSelection: action.selection } : {}),
        ...(action.toolName !== undefined ? { permissionToolName: action.toolName } : {}),
      };

    case 'CLEAR_PERMISSION':
      return { ...state, permissionOptions: [], permissionMenuSelection: 0, permissionToolName: '' };

    case 'SET_QUEUED_INPUT':
      return { ...state, queuedInput: action.text, queuedCursor: action.cursor };

    case 'SET_MODEL_LIST':
      return { ...state, allModelNames: action.models };

    case 'CLEAR_MESSAGES':
      return { ...state, messages: [], view: 'welcome' };

    case 'SET_TOOLS_SHOWN':
      return { ...state, toolsShown: action.shown };

    case 'SET_START_INFO':
      return {
        ...state,
        modelName: action.model,
        modelSize: action.modelSize,
        toolCount: action.toolCount,
        modelCount: action.modelCount,
        version: action.version,
        apiPort: action.apiPort,
      };

    case 'FORCE_RENDER':
      return { ...state, renderTick: state.renderTick + 1 };

    case 'SET_INPUT_ACTIVE':
      return { ...state, inputActive: action.active };

    default:
      return state;
  }
}

// ─── App Handle (exposed to TUI class via ref) ──────────────────────────────

export interface AppHandle {
  dispatch: React.Dispatch<AppAction>;
  getState: () => AppState;
}

// ─── App Component ───────────────────────────────────────────────────────────

export const App = forwardRef<AppHandle>(function App(_props, ref) {
  const [state, dispatch] = useReducer(appReducer, initialState);
  const { stdout } = useStdout();

  const rows = stdout?.rows || 24;
  const cols = stdout?.columns || 80;

  // Expose dispatch + getState via ref
  const stateRef = React.useRef(state);
  stateRef.current = state;

  useImperativeHandle(ref, () => ({
    dispatch,
    getState: () => stateRef.current,
  }), [dispatch]);

  // Keep useInput active so Ink maintains raw mode on stdin.
  // Actual input handling is done by the TUI class via raw stdin listener.
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  useInput(() => {});

  return (
    <>
      <ProgressBar
        active={state.progressBarActive}
        enabled={state.progressBarEnabled}
        cols={cols}
      />
      {state.view === 'welcome' && state.messages.length === 0 ? (
        <WelcomeScreen
          state={state}
          rows={rows - 1}
          cols={cols}
          hasResolveInput={state.inputActive}
        />
      ) : (
        <Conversation
          state={state}
          rows={rows - 1}
          cols={cols}
          hasResolveInput={state.inputActive}
        />
      )}
    </>
  );
});
