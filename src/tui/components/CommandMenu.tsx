import React from 'react';
import { Box, Text } from 'ink';
import chalk from 'chalk';
import { theme, box } from '../theme.js';
import type { CommandDef } from '../types.js';

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

function truncateStr(text: string, maxWidth: number): string {
  const stripped = stripAnsi(text);
  if (stripped.length <= maxWidth) return text;
  return stripped.slice(0, maxWidth - 1) + '…';
}

interface CommandMenuProps {
  visible: boolean;
  commands: CommandDef[];
  selection: number;
  cols: number;
}

export function CommandMenu({ visible, commands, selection, cols }: CommandMenuProps): React.ReactElement | null {
  if (!visible || commands.length === 0) return null;

  const boxWidth = cols - 4;
  const menuMaxVisible = Math.min(commands.length, 12);

  const topBorder = theme.border(box.roundTl + box.h.repeat(boxWidth - 2) + box.roundTr);
  const bottomBorder = theme.border(box.roundBl + box.h.repeat(boxWidth - 2) + box.roundBr);

  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Text>{topBorder}</Text>
      {commands.slice(0, menuMaxVisible).map((cmd, i) => {
        const isSelected = i === selection;
        const nameStr = cmd.name.padEnd(22);
        const descStr = truncateStr(cmd.description, boxWidth - 28);

        if (isSelected) {
          const line = ` ${theme.brandBold(nameStr)} ${theme.text(descStr)}`;
          const lineLen = stripAnsi(line).length;
          const padded = line + ' '.repeat(Math.max(0, boxWidth - 4 - lineLen));
          return <Text key={i}>{theme.border(box.v)}{chalk.bgHex('#2A2A4A')(` ${padded} `)}{theme.border(box.v)}</Text>;
        } else {
          const line = ` ${theme.accent(nameStr)} ${theme.muted(descStr)}`;
          const lineLen = stripAnsi(line).length;
          const padded = line + ' '.repeat(Math.max(0, boxWidth - 4 - lineLen));
          return <Text key={i}>{theme.border(box.v)} {padded} {theme.border(box.v)}</Text>;
        }
      })}
      <Text>{bottomBorder}</Text>
    </Box>
  );
}
