import React from 'react';
import { Box, Text } from 'ink';
import chalk from 'chalk';
import { theme, box, icons } from '../theme.js';
import type { ModelItem } from '../types.js';

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

interface ModelSelectorProps {
  active: boolean;
  items: ModelItem[];
  selectedIndex: number;
  cols: number;
  maxVisible: number;
}

export function ModelSelector({ active, items, selectedIndex, cols, maxVisible }: ModelSelectorProps): React.ReactElement | null {
  if (!active || items.length === 0) return null;

  const boxWidth = cols - 4;
  const visibleCount = Math.min(items.length, maxVisible);

  // Window around selected item
  let windowStart = Math.max(0, selectedIndex - Math.floor(visibleCount / 2));
  if (windowStart + visibleCount > items.length) {
    windowStart = Math.max(0, items.length - visibleCount);
  }
  const windowEnd = Math.min(windowStart + visibleCount, items.length);

  // Top border with title
  const title = ' Select a model ';
  const borderLeft = box.h.repeat(2);
  const borderRight = box.h.repeat(Math.max(0, boxWidth - 2 - borderLeft.length - title.length));
  const topBorder = theme.borderFocused(box.roundTl + borderLeft + title + borderRight + box.roundTr);

  // Bottom border with hints
  const hintText = ' Esc:cancel  ↑↓/jk:navigate  Enter:use  Space:default ';
  const hintBorderLeft = box.h.repeat(2);
  const hintBorderRight = box.h.repeat(Math.max(0, boxWidth - 2 - hintBorderLeft.length - hintText.length));
  const bottomBorder = theme.borderFocused(
    box.roundBl + hintBorderLeft + theme.dim(hintText) + hintBorderRight + box.roundBr
  );

  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Text>{topBorder}</Text>
      {items.slice(windowStart, windowEnd).map((m, i) => {
        const wi = windowStart + i;
        const isSelected = wi === selectedIndex;
        const pointer = isSelected ? `${icons.arrow} ` : '  ';
        const activeTag = m.active ? ' ← active' : '';
        const caps = m.caps.length > 0 ? ` [${m.caps.join(', ')}]` : '';
        const scoreStr = ` (${m.score})`;
        const lineText = `${pointer}${m.name.padEnd(32)} ${m.size.padEnd(8)}${caps}${scoreStr}${activeTag}`;
        const truncated = lineText.length > boxWidth - 4 ? lineText.slice(0, boxWidth - 5) + '…' : lineText;
        const padded = truncated + ' '.repeat(Math.max(0, boxWidth - 4 - truncated.length));

        if (isSelected) {
          return (
            <Text key={wi}>
              {theme.borderFocused(box.v)}{chalk.bgHex('#2A2A4A')(` ${theme.accent(padded)} `)}{theme.borderFocused(box.v)}
            </Text>
          );
        }
        return (
          <Text key={wi}>
            {theme.borderFocused(box.v)} {padded} {theme.borderFocused(box.v)}
          </Text>
        );
      })}
      <Text>{bottomBorder}</Text>
    </Box>
  );
}
