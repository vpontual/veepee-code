import React, { useReducer, useImperativeHandle, forwardRef } from 'react';
import { useStdout, useInput } from 'ink';
import { WelcomeScreen } from './components/WelcomeScreen.js';
import { Conversation } from './components/Conversation.js';
import { ProgressBar } from './components/ProgressBar.js';
import type { AppState, AppAction, CommandDef } from './types.js';
import { appReducer, initialState } from './reducer.js';

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
  { name: '/copy', args: '', description: 'Copy last response to clipboard (also Ctrl+Y)' },
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
  { name: '/rc qr', args: '', description: 'Show scannable QR code for phone access' },
  { name: '/settings', args: '', description: 'View and toggle settings' },
  { name: '/settings progress-bar', args: '', description: 'Toggle progress bar animation' },
  { name: '/settings model_stick', args: '', description: 'Lock current model across mode switches' },
  { name: '/quit', args: '', description: 'Exit VEEPEE Code' },
  { name: '/exit', args: '', description: 'Exit VEEPEE Code' },
];

// Reducer and initial state imported from reducer.ts (React-free, testable)
// DO NOT redefine appReducer or initialState here — they live in reducer.ts

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
