import React from 'react';
import { Box, Text } from 'ink';
import { icons } from '../theme.js';

interface StatusBarProps {
  tokenCount: number;
  tokenPercent: number;
  messageCount: number;
  apiPort: number;
  version: string;
}

export function StatusBar({ tokenCount, tokenPercent, messageCount, apiPort, version }: StatusBarProps): React.ReactElement {
  const cwd = process.cwd().replace(process.env.HOME || '', '~');

  const contextInfo = messageCount > 0
    ? `${tokenCount.toLocaleString()} tok ${tokenPercent}%  `
    : '';

  return (
    <Box width="100%">
      <Box flexGrow={1}>
        <Text dimColor> {cwd}</Text>
      </Box>
      <Box>
        <Text dimColor>{contextInfo}{icons.dot} API :{apiPort}  v{version} {icons.llama} </Text>
      </Box>
    </Box>
  );
}
