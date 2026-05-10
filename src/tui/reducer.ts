import type { AppState, AppAction, TreeViewItem, TreeViewFilter } from './types.js';

/** Filter the active-path tree-view items by mode. Pure helper so both
 *  reducer and component agree on what's visible. */
export function filteredTreeItems(items: TreeViewItem[], filter: TreeViewFilter): TreeViewItem[] {
  switch (filter) {
    case 'all':
      return items;
    case 'user-only':
      return items.filter(i => i.type === 'message' && i.role === 'user');
    case 'labeled-only':
      return items.filter(i => i.labels.length > 0);
    case 'default':
    default:
      // Hide: tool messages (results), bare model/mode-change events, custom
      // entries (knowledge state etc.). Show: user, assistant, system, meta,
      // compaction, label.
      return items.filter(i => {
        if (i.type === 'message' && i.role === 'tool') return false;
        if (i.type === 'model_change' || i.type === 'mode_change') return false;
        if (i.type === 'custom') return false;
        return true;
      });
  }
}

const FILTER_CYCLE: TreeViewFilter[] = ['default', 'user-only', 'labeled-only', 'all'];

function nextFilter(cur: TreeViewFilter): TreeViewFilter {
  const idx = FILTER_CYCLE.indexOf(cur);
  return FILTER_CYCLE[(idx + 1) % FILTER_CYCLE.length];
}

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
  apiConnected: false,
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
  pendingMessages: { steering: [], followUp: [] },
  treeViewActive: false,
  treeViewItems: [],
  treeViewIndex: 0,
  treeViewFilter: 'default',
  treeViewLabelInput: { active: false, text: '', cursor: 0 },
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
    case 'APPEND_STREAM':
      return { ...state, streamBuffer: state.streamBuffer + action.text };

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

    case 'SCROLL_DOWN': {
      // SCROLL_TOP saturates scrollOffset to a sentinel; if the user then
      // scrolls down, estimate a starting point near maxScroll using message
      // count rather than decrementing the sentinel (would no-op visibly).
      // The renderer re-clamps to the true maxScroll on the next render.
      const SATURATION_THRESHOLD = Number.MAX_SAFE_INTEGER / 2;
      const current = state.scrollOffset > SATURATION_THRESHOLD
        ? state.messages.length * 30
        : state.scrollOffset;
      return { ...state, scrollOffset: Math.max(0, current - action.amount) };
    }

    case 'SCROLL_TOP':
      // Saturate; renderer clamps to actual maxScroll. SCROLL_DOWN unwraps it.
      return { ...state, scrollOffset: Number.MAX_SAFE_INTEGER };

    case 'SCROLL_BOTTOM':
      return { ...state, scrollOffset: 0 };

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

    case 'END_STREAM': {
      const newMsgs = [...state.messages];
      if (state.streamBuffer.trim()) {
        newMsgs.push({ role: 'assistant', content: state.streamBuffer.trim() });
        if (newMsgs.length > 500) newMsgs.splice(0, newMsgs.length - 400);
      }
      return { ...state, streamBuffer: '', streamActive: false, progressBarActive: false, view: 'conversation', messages: newMsgs };
    }

    case 'RESET_STREAM':
      // Retroactively clear the live stream buffer. Used when orphan </think>
      // in the response turns out to have been reasoning we should not have
      // shown; the reasoning is then posted separately as a collapsed thinking
      // message, and streaming continues with the actual answer.
      return { ...state, streamBuffer: '' };

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

    case 'QUEUE_STEERING': {
      const text = action.text.trim();
      if (!text) return state;
      return {
        ...state,
        queuedInput: '',
        queuedCursor: 0,
        pendingMessages: {
          ...state.pendingMessages,
          steering: [...state.pendingMessages.steering, text],
        },
      };
    }

    case 'QUEUE_FOLLOWUP': {
      const text = action.text.trim();
      if (!text) return state;
      return {
        ...state,
        queuedInput: '',
        queuedCursor: 0,
        pendingMessages: {
          ...state.pendingMessages,
          followUp: [...state.pendingMessages.followUp, text],
        },
      };
    }

    case 'POP_PENDING_TO_INPUT': {
      // Pop most-recent across both queues (last-pushed wins). Restores it
      // to the typing buffer so the user can edit or re-queue.
      const { steering, followUp } = state.pendingMessages;
      let text: string | undefined;
      let nextSteering = steering;
      let nextFollowUp = followUp;
      if (followUp.length > 0) {
        text = followUp[followUp.length - 1];
        nextFollowUp = followUp.slice(0, -1);
      } else if (steering.length > 0) {
        text = steering[steering.length - 1];
        nextSteering = steering.slice(0, -1);
      }
      if (text === undefined) return state;
      return {
        ...state,
        queuedInput: text,
        queuedCursor: text.length,
        pendingMessages: { steering: nextSteering, followUp: nextFollowUp },
      };
    }

    case 'CLEAR_PENDING':
      return {
        ...state,
        pendingMessages: { steering: [], followUp: [] },
      };

    case 'DRAIN_STEERING':
      return {
        ...state,
        pendingMessages: { ...state.pendingMessages, steering: [] },
      };

    case 'DRAIN_FOLLOWUP':
      return {
        ...state,
        pendingMessages: { ...state.pendingMessages, followUp: [] },
      };

    case 'TREE_VIEW_OPEN':
      return {
        ...state,
        treeViewActive: true,
        treeViewItems: action.items,
        treeViewIndex: 0,
        treeViewFilter: 'default',
        treeViewLabelInput: { active: false, text: '', cursor: 0 },
      };

    case 'TREE_VIEW_CLOSE':
      return {
        ...state,
        treeViewActive: false,
        treeViewItems: [],
        treeViewIndex: 0,
        treeViewLabelInput: { active: false, text: '', cursor: 0 },
      };

    case 'TREE_VIEW_NAV': {
      const visible = filteredTreeItems(state.treeViewItems, state.treeViewFilter);
      if (visible.length === 0) return state;
      const next = Math.max(0, Math.min(visible.length - 1, state.treeViewIndex + action.delta));
      return { ...state, treeViewIndex: next };
    }

    case 'TREE_VIEW_SET_INDEX': {
      const visible = filteredTreeItems(state.treeViewItems, state.treeViewFilter);
      if (visible.length === 0) return state;
      const next = Math.max(0, Math.min(visible.length - 1, action.index));
      return { ...state, treeViewIndex: next };
    }

    case 'TREE_VIEW_CYCLE_FILTER': {
      const filter = nextFilter(state.treeViewFilter);
      // Reset index to 0 on filter change — the previous selection may not
      // exist in the new filtered view; clean reset is simpler than trying
      // to track the same logical entry across filter modes.
      return { ...state, treeViewFilter: filter, treeViewIndex: 0 };
    }

    case 'TREE_VIEW_LABEL_INPUT':
      return {
        ...state,
        treeViewLabelInput: {
          active: action.active,
          text: action.text ?? '',
          cursor: action.cursor ?? (action.text?.length ?? 0),
        },
      };

    case 'TREE_VIEW_REPLACE_ITEMS':
      return { ...state, treeViewItems: action.items };

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

    case 'SET_API_CONNECTED':
      if (state.apiConnected === action.connected) return state;
      return { ...state, apiConnected: action.connected };

    default:
      return state;
  }
}
