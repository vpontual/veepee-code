import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { theme, icons } from '../theme.js';
import type { TurnTracker as TurnTrackerType } from '../types.js';

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

interface TurnTrackerProps {
  tracker: TurnTrackerType;
  cols: number;
}

export function TurnTrackerView({ tracker, cols }: TurnTrackerProps): React.ReactElement | null {
  const [, setTick] = useState(0);

  // Re-render every 500ms for spinner + elapsed time updates
  useEffect(() => {
    if (!tracker.active) return;
    const interval = setInterval(() => setTick(t => t + 1), 500);
    return () => clearInterval(interval);
  }, [tracker.active]);

  if (!tracker.active) return null;

  const elapsed = ((Date.now() - tracker.startTime) / 1000).toFixed(1);
  const toolCount = tracker.toolCalls.length;
  const tokStr = tracker.tokensEstimate > 1000
    ? `${(tracker.tokensEstimate / 1000).toFixed(1)}k`
    : String(tracker.tokensEstimate);

  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  const frame = frames[Math.floor(Date.now() / 80) % frames.length];

  const header = `${theme.accent(frame)} ${theme.textBold('Running...')} ${theme.muted(`(${toolCount} tool calls ${icons.dot} ${tokStr} tokens ${icons.dot} ${elapsed}s)`)}`;

  const maxVisible = 5;
  const visibleCalls = tracker.toolCalls.slice(-maxVisible);
  const hasMore = tracker.toolCalls.length > maxVisible;

  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Text>{header}</Text>

      {hasMore && (
        <Text>{theme.muted(`  ${icons.dot}${icons.dot}${icons.dot} ${tracker.toolCalls.length - maxVisible} earlier`)}</Text>
      )}

      {visibleCalls.map((tc, i) => {
        const isLast = i === visibleCalls.length - 1;
        const connector = isLast ? '└─' : '├─';

        let statusIcon: string;
        let statusColor = theme.muted;
        if (tc.status === 'running') {
          statusIcon = theme.accent(frame);
          statusColor = theme.accent;
        } else if (tc.status === 'done') {
          statusIcon = theme.success(icons.check);
        } else {
          statusIcon = theme.error(icons.cross);
          statusColor = theme.error;
        }

        const elapsedStr = tc.elapsed ? theme.muted(` ${(tc.elapsed / 1000).toFixed(1)}s`) : '';
        const tcLine = `  ${theme.muted(connector)} ${statusIcon} ${statusColor(tc.name)}${elapsedStr}`;

        return <Text key={i}>{tcLine}</Text>;
      })}
    </Box>
  );
}
