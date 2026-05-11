import React, { useReducer, useImperativeHandle, forwardRef } from 'react';
import { useStdout, useInput } from 'ink';
import { WelcomeScreen } from './components/WelcomeScreen.js';
import { Conversation } from './components/Conversation.js';
import { ProgressBar } from './components/ProgressBar.js';
import type { AppState, AppAction } from './types.js';
import { appReducer, initialState } from './reducer.js';

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
