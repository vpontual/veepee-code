import React from 'react';
import { Box, Text } from 'ink';
import { icons } from '../theme.js';
import { getStatusline } from '../../statusline.js';

interface StatusBarProps {
  tokenCount: number;
  tokenPercent: number;
  messageCount: number;
  apiPort: number;
  apiConnected: boolean;
  version: string;
  // Optional state passed through to the user's statusline script. When
  // `model` is unknown at render time (early boot), the built-in display
  // is used regardless of script presence.
  model?: string;
  mode?: 'act' | 'plan' | 'chat';
}

export function StatusBar({
  tokenCount, tokenPercent, apiPort, apiConnected, version,
  model, mode,
}: StatusBarProps): React.ReactElement {
  const cwd = process.cwd().replace(process.env.HOME || '', '~');

  // Custom statusline takes precedence when configured. Returns null fast
  // (cached) when there's no script, so the built-in render is the default.
  const customLine = model && mode
    ? getStatusline({
        model, mode,
        tokens: tokenCount, tokenPercent,
        cwd: process.cwd(),
        sessionId: null,
        apiPort, apiConnected,
        version,
      })
    : null;

  if (customLine) {
    // User script wins — render its output verbatim. The script is
    // responsible for whatever formatting it wants (token count, model,
    // git branch, time, etc.). Built-in cwd is left-aligned still.
    return (
      <Box width="100%">
        <Box flexGrow={1}>
          <Text dimColor> {cwd}</Text>
        </Box>
        <Box>
          <Text dimColor>{customLine} </Text>
        </Box>
      </Box>
    );
  }

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
