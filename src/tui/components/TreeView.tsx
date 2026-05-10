import React from 'react';
import { Box, Text } from 'ink';
import chalk from 'chalk';
import { theme, box, icons } from '../theme.js';
import { filteredTreeItems } from '../reducer.js';
import type { TreeViewItem, TreeViewFilter } from '../types.js';

interface TreeViewProps {
  active: boolean;
  items: TreeViewItem[];
  index: number;
  filter: TreeViewFilter;
  labelInput: { active: boolean; text: string; cursor: number };
  cols: number;
  maxVisible: number;
}

const FILTER_LABELS: Record<TreeViewFilter, string> = {
  default: 'default',
  'user-only': 'user only',
  'labeled-only': 'labeled only',
  all: 'all',
};

function renderRow(item: TreeViewItem, width: number): string {
  const idx = String(item.pathIndex).padStart(3);
  let typeTag: string;
  let body: string;
  switch (item.type) {
    case 'meta':
      typeTag = theme.dim('meta'.padEnd(7));
      body = item.preview;
      break;
    case 'message':
      switch (item.role) {
        case 'user':       typeTag = theme.accent('user'.padEnd(7)); break;
        case 'assistant':  typeTag = theme.success('asst'.padEnd(7)); break;
        case 'tool':       typeTag = theme.dim('tool'.padEnd(7)); break;
        case 'system':     typeTag = theme.muted('sys'.padEnd(7)); break;
        default:           typeTag = theme.dim((item.role ?? '?').padEnd(7));
      }
      body = item.preview;
      break;
    case 'compaction':
      typeTag = theme.warning('compact'.padEnd(7));
      body = theme.dim('(summary)');
      break;
    case 'label':
      typeTag = theme.warning('label  ');
      body = theme.warning(`★ ${item.preview}`);
      break;
    default:
      typeTag = theme.dim(item.type.slice(0, 7).padEnd(7));
      body = item.preview;
  }
  const labels = item.labels.length > 0
    ? '  ' + item.labels.map(n => theme.warning(`★ ${n}`)).join(' ')
    : '';
  const leafTag = item.isLeaf ? `  ${theme.accent('← leaf')}` : '';
  const line = `${idx}  ${typeTag}  ${body}${labels}${leafTag}`;
  // truncate to width (best-effort — chalk codes count toward visual width
  // calculation in stripped form). Clip the body, not the prefix.
  const stripped = line.replace(/\[[0-9;]*m/g, '');
  if (stripped.length <= width) return line;
  // Crude clip: take stripped char count, slice raw to that point.
  return line.slice(0, width - 1) + '…';
}

export function TreeView({
  active, items, index, filter, labelInput, cols, maxVisible,
}: TreeViewProps): React.ReactElement | null {
  if (!active) return null;
  const visible = filteredTreeItems(items, filter);
  const boxWidth = cols - 4;
  const contentWidth = boxWidth - 4;

  const title = ` Tree — ${visible.length}/${items.length} entries  •  filter: ${FILTER_LABELS[filter]} `;
  const titleBorder = box.h.repeat(2);
  const titleRest = box.h.repeat(Math.max(0, boxWidth - 2 - titleBorder.length - title.length));
  const topBorder = theme.borderFocused(box.roundTl + titleBorder + title + titleRest + box.roundTr);

  const hint = labelInput.active
    ? ' Esc:cancel  Enter:save label '
    : ' ↑↓:nav  Enter:rewind  Ctrl+O:filter  Shift+L:label  Esc:cancel ';
  const hintBorder = box.h.repeat(2);
  const hintRest = box.h.repeat(Math.max(0, boxWidth - 2 - hintBorder.length - hint.length));
  const bottomBorder = theme.borderFocused(box.roundBl + hintBorder + theme.dim(hint) + hintRest + box.roundBr);

  // Window calculation
  const visibleCount = Math.min(visible.length, maxVisible);
  let windowStart = Math.max(0, index - Math.floor(visibleCount / 2));
  if (windowStart + visibleCount > visible.length) {
    windowStart = Math.max(0, visible.length - visibleCount);
  }
  const windowEnd = Math.min(windowStart + visibleCount, visible.length);

  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Text>{topBorder}</Text>
      {visible.length === 0 && (
        <Text>{theme.borderFocused(box.v)} {theme.dim('  (no entries match this filter)'.padEnd(contentWidth))} {theme.borderFocused(box.v)}</Text>
      )}
      {visible.slice(windowStart, windowEnd).map((it, i) => {
        const wi = windowStart + i;
        const isSelected = wi === index;
        const pointer = isSelected ? `${icons.arrow} ` : '  ';
        const row = renderRow(it, contentWidth - 2);
        const padded = (pointer + row).slice(0, contentWidth);
        const fill = ' '.repeat(Math.max(0, contentWidth - padded.replace(/\[[0-9;]*m/g, '').length));
        if (isSelected) {
          return (
            <Text key={it.id}>
              {theme.borderFocused(box.v)}{chalk.bgHex('#2A2A4A')(` ${padded + fill} `)}{theme.borderFocused(box.v)}
            </Text>
          );
        }
        return (
          <Text key={it.id}>
            {theme.borderFocused(box.v)} {padded + fill} {theme.borderFocused(box.v)}
          </Text>
        );
      })}
      {labelInput.active && (
        <>
          <Text>{theme.borderFocused(box.v)} {theme.dim('  Label name:'.padEnd(contentWidth))} {theme.borderFocused(box.v)}</Text>
          <Text>{theme.borderFocused(box.v)} {(`  ${renderInput(labelInput.text, labelInput.cursor, contentWidth - 2)}`).slice(0, contentWidth).padEnd(contentWidth)} {theme.borderFocused(box.v)}</Text>
        </>
      )}
      <Text>{bottomBorder}</Text>
    </Box>
  );
}

function renderInput(text: string, cursor: number, width: number): string {
  const view = text.slice(0, width);
  const c = Math.min(cursor, view.length);
  const before = view.slice(0, c);
  const cursorChar = c < view.length ? view[c] : ' ';
  const after = view.slice(c + 1);
  return before + chalk.inverse(cursorChar) + after;
}
