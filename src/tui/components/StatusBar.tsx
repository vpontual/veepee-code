import React from 'react';
import { Box, Text } from 'ink';
import { icons } from '../theme.js';

interface StatusBarProps {
  tokenCount: number;
  tokenPercent: number;
  messageCount: number;
  apiPort: number;
  apiConnected: boolean;
  version: string;
}

export function StatusBar({ tokenCount, tokenPercent, apiPort, apiConnected, version }: StatusBarProps): React.ReactElement {
  const cwd = process.cwd().replace(process.env.HOME || '', '~');

  const contextInfo = `${tokenCount.toLocaleString()} tok ${tokenPercent}%  `;
  const apiSegment = apiConnected ? `${icons.dot} API :${apiPort}  ` : '';

  return (
    <Box width="100%">
      <Box flexGrow={1}>
        <Text dimColor> {cwd}</Text>
      </Box>
      <Box>
        <Text dimColor>{contextInfo}{apiSegment}v{version} {icons.llama} </Text>
      </Box>
    </Box>
  );
}
