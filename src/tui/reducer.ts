import type { AppState, AppAction } from './types.js';

export const initialState: AppState = {
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

export function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'SET_VIEW':
      return { ...state, view: action.view };

    case 'ADD_MESSAGE': {
      const messages = [...state.messages, action.message];
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
      const calls = state.turnTracker.toolCalls.map(t => {
        if (t.name === action.name && t.status === 'running') {
          return { ...t, status: action.status, elapsed: action.elapsed };
        }
        return t;
      });
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
