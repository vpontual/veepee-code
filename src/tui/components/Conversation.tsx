import React from 'react';
import { Box } from 'ink';
import { MessagesArea } from './MessagesArea.js';
import { TurnTrackerView } from './TurnTracker.js';
import { InputBox } from './InputBox.js';
import { StatusBar } from './StatusBar.js';
import { CommandMenu } from './CommandMenu.js';
import { ModelCompletion } from './ModelCompletion.js';
import { ModelSelector } from './ModelSelector.js';
import type { AppState } from '../types.js';

interface ConversationProps {
  state: AppState;
  rows: number;
  cols: number;
  hasResolveInput: boolean;
}

export function Conversation({ state, rows, cols, hasResolveInput }: ConversationProps): React.ReactElement {
  // Layout calculation
  const statusBarHeight = 1;
  const hintsHeight = 1;
  const inputBoxHeight = 4;
  const totalBottomHeight = inputBoxHeight + hintsHeight + statusBarHeight;
  const trackerHeight = state.turnTracker?.active
    ? Math.min(state.turnTracker.toolCalls.length + 1, 8)
    : 0;
  const progressBarHeight = 1;

  // Calculate menu heights (menus render between messages and input box)
  let menuHeight = 0;
  if (state.modelSelectorActive && state.modelSelectorItems.length > 0) {
    menuHeight = Math.min(state.modelSelectorItems.length, 12) + 2; // +2 for borders
  } else if (state.commandMenuVisible && state.filteredCommands.length > 0) {
    menuHeight = Math.min(state.filteredCommands.length, 12) + 2;
  } else if (state.modelCompletionVisible && state.modelCompletionItems.length > 0) {
    menuHeight = Math.min(state.modelCompletionItems.length, 12) + 2;
  }

  const messagesHeight = rows - totalBottomHeight - trackerHeight - progressBarHeight - menuHeight - 1;

  // How many rows available for menus above input
  const menuMaxVisible = Math.max(4, messagesHeight);

  return (
    <Box flexDirection="column" width={cols} height={rows}>
      {/* Messages area (takes remaining space — flexGrow pushes input to bottom) */}
      <Box flexGrow={1} flexDirection="column">
        <MessagesArea
          messages={state.messages}
          streamActive={state.streamActive}
          streamBuffer={state.streamBuffer}
          permissionActive={state.permissionOptions.length > 0}
          permissionOptions={state.permissionOptions}
          permissionMenuSelection={state.permissionMenuSelection}
          scrollOffset={state.scrollOffset}
          visibleRows={Math.max(1, messagesHeight)}
          cols={cols}
        />
      </Box>

      {/* Turn tracker */}
      {state.turnTracker?.active && (
        <TurnTrackerView tracker={state.turnTracker} cols={cols} />
      )}

      {/* Overlay menus (rendered above input box) */}
      <CommandMenu
        visible={state.commandMenuVisible}
        commands={state.filteredCommands}
        selection={state.commandMenuSelection}
        cols={cols}
      />
      <ModelCompletion
        visible={state.modelCompletionVisible}
        items={state.modelCompletionItems}
        selection={state.modelCompletionSelection}
        cols={cols}
      />
      <ModelSelector
        active={state.modelSelectorActive}
        items={state.modelSelectorItems}
        selectedIndex={state.modelSelectorIndex}
        cols={cols}
        maxVisible={menuMaxVisible}
      />

      {/* Input box */}
      <InputBox
        input={state.input}
        modelName={state.modelName}
        modelSize={state.modelSize}
        modelRole={state.modelRole}
        providerName={state.providerName}
        isWaiting={!hasResolveInput}
        hasResolveInput={hasResolveInput}
        queuedInput={state.queuedInput}
        queuedCursor={state.queuedCursor}
        cols={cols}
      />

      {/* Status bar */}
      <StatusBar
        tokenCount={state.tokenCount}
        tokenPercent={state.tokenPercent}
        messageCount={state.messageCount}
        apiPort={state.apiPort}
        apiConnected={state.apiConnected}
        version={state.version}
      />
    </Box>
  );
}
