import React from 'react';
import { Box, Text } from 'ink';
import chalk from 'chalk';
import { theme, box } from '../theme.js';

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

interface ModelCompletionProps {
  visible: boolean;
  items: Array<{ name: string; size: string }>;
  selection: number;
  cols: number;
}

export function ModelCompletion({ visible, items, selection, cols }: ModelCompletionProps): React.ReactElement | null {
  if (!visible || items.length === 0) return null;

  const boxWidth = cols - 4;
  const menuMaxVisible = Math.min(items.length, 12);

  const topBorder = theme.border(box.roundTl + box.h.repeat(boxWidth - 2) + box.roundTr);
  const bottomBorder = theme.border(box.roundBl + box.h.repeat(boxWidth - 2) + box.roundBr);

  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Text>{topBorder}</Text>
      {items.slice(0, menuMaxVisible).map((m, i) => {
        const isSelected = i === selection;
        const nameStr = m.name.padEnd(35);
        const sizeStr = m.size;

        if (isSelected) {
          const line = ` ${theme.brandBold(nameStr)} ${theme.text(sizeStr)}`;
          const lineLen = stripAnsi(line).length;
          const padded = line + ' '.repeat(Math.max(0, boxWidth - 4 - lineLen));
          return <Text key={i}>{theme.border(box.v)}{chalk.bgHex('#2A2A4A')(` ${padded} `)}{theme.border(box.v)}</Text>;
        } else {
          const line = ` ${theme.accent(nameStr)} ${theme.muted(sizeStr)}`;
          const lineLen = stripAnsi(line).length;
          const padded = line + ' '.repeat(Math.max(0, boxWidth - 4 - lineLen));
          return <Text key={i}>{theme.border(box.v)} {padded} {theme.border(box.v)}</Text>;
        }
      })}
      <Text>{bottomBorder}</Text>
    </Box>
  );
}
