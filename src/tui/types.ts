export interface Message {
  role: 'user' | 'assistant' | 'tool_call' | 'tool_result' | 'system' | 'model_switch' | 'thinking';
  content: string;
  meta?: string;
  success?: boolean;
  timestamp?: number;
  collapsed?: boolean;
}

export interface TurnTracker {
  startTime: number;
  toolCalls: Array<{ name: string; status: 'running' | 'done' | 'error'; elapsed?: number }>;
  tokensEstimate: number;
  model: string;
  active: boolean;
}

export interface InputState {
  text: string;
  cursor: number;
  history: string[];
  historyIdx: number;
}

export interface CommandDef {
  name: string;
  args: string;
  description: string;
}

export interface ModelItem {
  name: string;
  size: string;
  score: number;
  tier: string;
  active: boolean;
  caps: string[];
}

export interface PermissionOption {
  label: string;
  value: string;
}

export type TreeViewFilter = 'all' | 'default' | 'user-only' | 'labeled-only';

export interface TreeViewItem {
  id: string;
  pathIndex: number;         // position in the active path (0-based)
  type: 'meta' | 'message' | 'compaction' | 'label' | 'model_change' | 'mode_change' | 'custom';
  preview: string;           // pre-rendered, ~60 chars
  role?: string;             // for messages: user/assistant/tool/system
  isLeaf: boolean;           // is this the current active leaf?
  labels: string[];          // names of any labels attached to this entry
}

export type AppView = 'welcome' | 'conversation' | 'waiting';

export interface AppState {
  view: AppView;
  messages: Message[];
  input: InputState;
  scrollOffset: number;
  modelName: string;
  modelSize: string;
  modelRole: string;
  providerName: string;
  toolCount: number;
  modelCount: number;
  tokenCount: number;
  tokenPercent: number;
  messageCount: number;
  elapsed: number;
  version: string;
  apiPort: number;
  apiConnected: boolean;
  streamBuffer: string;
  streamActive: boolean;
  progressBarActive: boolean;
  turnTracker: TurnTracker | null;
  progressBarEnabled: boolean;
  updateAvailable: { behind: number } | null;
  // Menus
  commandMenuVisible: boolean;
  commandMenuSelection: number;
  filteredCommands: CommandDef[];
  modelCompletionVisible: boolean;
  modelCompletionItems: Array<{ name: string; size: string }>;
  modelCompletionSelection: number;
  modelSelectorActive: boolean;
  modelSelectorItems: ModelItem[];
  modelSelectorIndex: number;
  permissionOptions: PermissionOption[];
  permissionMenuSelection: number;
  permissionToolName: string;
  // Input queueing
  queuedInput: string;     // typing buffer while agent runs (not yet committed)
  queuedCursor: number;
  // Pending messages committed for delivery (steering = mid-turn, followUp = on idle)
  pendingMessages: { steering: string[]; followUp: string[] };
  // /tree picker state
  treeViewActive: boolean;
  treeViewItems: TreeViewItem[];
  treeViewIndex: number;        // index INTO THE FILTERED VIEW
  treeViewFilter: TreeViewFilter;
  treeViewLabelInput: { active: boolean; text: string; cursor: number };
  // Misc
  toolsShown: boolean;
  allModelNames: Array<{ name: string; size: string }>;
  renderTick: number;
  inputActive: boolean;  // whether getInput() promise is active
}

export type AppAction =
  | { type: 'SET_VIEW'; view: AppView }
  | { type: 'ADD_MESSAGE'; message: Message }
  | { type: 'REPLACE_LAST_THINKING'; message: Message }
  | { type: 'SET_INPUT'; input: Partial<InputState> }
  | { type: 'SET_SCROLL'; offset: number }
  | { type: 'SCROLL_UP'; amount: number }
  | { type: 'SCROLL_DOWN'; amount: number }
  | { type: 'SCROLL_TOP' }
  | { type: 'SCROLL_BOTTOM' }
  | { type: 'SET_MODEL'; name: string; size?: string; role?: string }
  | { type: 'SET_STATS'; tokens: number; percent: number; messages: number; elapsed: number }
  | { type: 'START_STREAM' }
  | { type: 'APPEND_STREAM'; text: string }
  | { type: 'END_STREAM' }
  | { type: 'RESET_STREAM' }
  | { type: 'SET_PROGRESS_BAR_ACTIVE'; active: boolean }
  | { type: 'SET_TURN_TRACKER'; tracker: TurnTracker | null }
  | { type: 'UPDATE_TOOL_CALL'; name: string; status: 'running' | 'done' | 'error'; elapsed?: number; tokensEstimate?: number }
  | { type: 'ADD_TOOL_CALL'; name: string }
  | { type: 'SET_PROGRESS_BAR'; enabled: boolean }
  | { type: 'SET_UPDATE_AVAILABLE'; behind: number }
  | { type: 'SET_COMMAND_MENU'; visible: boolean; selection?: number; filtered?: CommandDef[] }
  | { type: 'SET_MODEL_COMPLETION'; visible: boolean; items?: Array<{ name: string; size: string }>; selection?: number }
  | { type: 'SET_MODEL_SELECTOR'; active: boolean; items?: ModelItem[]; index?: number }
  | { type: 'SET_PERMISSION'; options: PermissionOption[]; selection?: number; toolName?: string }
  | { type: 'CLEAR_PERMISSION' }
  | { type: 'SET_QUEUED_INPUT'; text: string; cursor: number }
  | { type: 'QUEUE_STEERING'; text: string }
  | { type: 'QUEUE_FOLLOWUP'; text: string }
  | { type: 'POP_PENDING_TO_INPUT' }
  | { type: 'CLEAR_PENDING' }
  | { type: 'DRAIN_STEERING' }
  | { type: 'DRAIN_FOLLOWUP' }
  | { type: 'TREE_VIEW_OPEN'; items: TreeViewItem[] }
  | { type: 'TREE_VIEW_CLOSE' }
  | { type: 'TREE_VIEW_NAV'; delta: number }
  | { type: 'TREE_VIEW_SET_INDEX'; index: number }
  | { type: 'TREE_VIEW_CYCLE_FILTER' }
  | { type: 'TREE_VIEW_LABEL_INPUT'; active: boolean; text?: string; cursor?: number }
  | { type: 'TREE_VIEW_REPLACE_ITEMS'; items: TreeViewItem[] }
  | { type: 'SET_MODEL_LIST'; models: Array<{ name: string; size: string }> }
  | { type: 'CLEAR_MESSAGES' }
  | { type: 'SET_TOOLS_SHOWN'; shown: boolean }
  | { type: 'POP_MESSAGE' }
  | { type: 'SET_START_INFO'; model: string; modelSize: string; toolCount: number; modelCount: number; version: string; apiPort: number }
  | { type: 'FORCE_RENDER' }
  | { type: 'SET_INPUT_ACTIVE'; active: boolean }
  | { type: 'SET_API_CONNECTED'; connected: boolean };
