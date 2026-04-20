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
  queuedInput: string;
  queuedCursor: number;
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
  | { type: 'SET_MODEL_LIST'; models: Array<{ name: string; size: string }> }
  | { type: 'CLEAR_MESSAGES' }
  | { type: 'SET_TOOLS_SHOWN'; shown: boolean }
  | { type: 'POP_MESSAGE' }
  | { type: 'SET_START_INFO'; model: string; modelSize: string; toolCount: number; modelCount: number; version: string; apiPort: number }
  | { type: 'FORCE_RENDER' }
  | { type: 'SET_INPUT_ACTIVE'; active: boolean };
