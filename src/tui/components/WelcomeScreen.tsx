import React from 'react';
import { Box, Text } from 'ink';
import chalk from 'chalk';
import { getLogo } from '../logo.js';
import { InputBox } from './InputBox.js';
import { StatusBar } from './StatusBar.js';
import type { AppState } from '../types.js';

function center(text: string, width: number): string {
  // eslint-disable-next-line no-control-regex
  const stripped = text.replace(/\x1b\[[0-9;]*m/g, '');
  const textLen = stripped.length;
  if (textLen >= width) return text;
  const left = Math.floor((width - textLen) / 2);
  return ' '.repeat(left) + text;
}

interface WelcomeScreenProps {
  state: AppState;
  rows: number;
  cols: number;
  hasResolveInput: boolean;
}

export function WelcomeScreen({ state, rows, cols, hasResolveInput }: WelcomeScreenProps): React.ReactElement {
  const logo = getLogo(cols);

  // Calculate vertical centering
  const logoHeight = logo.length;
  const inputBoxHeight = 5;
  const contentHeight = logoHeight + 4 + inputBoxHeight;
  const topPadding = Math.max(1, Math.floor((rows - contentHeight) / 2) - 2);

  return (
    <Box flexDirection="column" width={cols} height={rows}>
      {/* Top padding */}
      {topPadding > 0 && <Box height={topPadding} />}

      {/* Logo centered */}
      {logo.map((line, i) => (
        <Text key={i}>{center(line, cols)}</Text>
      ))}

      {/* Update notice */}
      {state.updateAvailable && (
        <Box marginTop={1}>
          <Text>{center(chalk.yellow(`Update available — run ${chalk.bold('vcode --update')}`), cols)}</Text>
        </Box>
      )}

      {/* Spacer */}
      <Box height={state.updateAvailable ? 1 : 3} />

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

      {/* Fill remaining space */}
      <Box flexGrow={1} />

      {/* Status bar at bottom */}
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
