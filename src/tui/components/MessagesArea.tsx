import React from 'react';
import { Box, Text } from 'ink';
import { theme, icons } from '../theme.js';
import { formatMessage } from './MessageBlock.js';
import type { Message, PermissionOption } from '../types.js';

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

function wordWrap(text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    if (paragraph.length <= maxWidth) {
      lines.push(paragraph);
      continue;
    }
    let line = '';
    for (const word of paragraph.split(/(\s+)/)) {
      if (stripAnsi(line + word).length > maxWidth) {
        if (line.trim()) lines.push(line.trimEnd());
        line = word.startsWith(' ') ? '' : word;
      } else {
        line += word;
      }
    }
    if (line.trim()) lines.push(line.trimEnd());
  }
  return lines;
}

interface MessagesAreaProps {
  messages: Message[];
  streamActive: boolean;
  streamBuffer: string;
  permissionActive: boolean;
  permissionOptions: PermissionOption[];
  permissionMenuSelection: number;
  scrollOffset: number;
  visibleRows: number;
  cols: number;
}

export function MessagesArea({
  messages, streamActive, streamBuffer,
  permissionActive, permissionOptions, permissionMenuSelection,
  scrollOffset, visibleRows, cols,
}: MessagesAreaProps): React.ReactElement {
  const maxWidth = cols - 4;

  // Build all rendered lines
  const renderedLines: string[] = [];

  for (let mi = 0; mi < messages.length; mi++) {
    const msg = messages[mi];
    const prevMsg = mi > 0 ? messages[mi - 1] : null;

    // Generous spacing between message blocks (like Claude Code)
    // Use ' ' not '' — Ink collapses empty strings to zero height
    if (mi > 0) {
      if (msg.role === 'user') {
        // Double blank line before user messages — major section break
        renderedLines.push(' ', ' ');
      } else if (msg.role === 'assistant' && prevMsg?.role !== 'assistant') {
        // Blank line before assistant response
        renderedLines.push(' ');
      } else if (msg.role === 'system' && prevMsg?.role === 'assistant') {
        // Blank line before completion badge
        renderedLines.push(' ');
      } else if (msg.role === 'tool_call' || msg.role === 'tool_result') {
        // Blank line before tool activity
        renderedLines.push(' ');
      }
    }

    const lines = formatMessage(msg, maxWidth);
    renderedLines.push(...lines);
  }

  // Add stream buffer if active (indent to match assistant text)
  if (streamActive && streamBuffer) {
    renderedLines.push(' ');
    const wrapped = wordWrap(streamBuffer, maxWidth - 2);
    for (const line of wrapped) {
      renderedLines.push('  ' + line);
    }
  }

  // Add permission menu if active
  if (permissionActive && permissionOptions.length > 0) {
    renderedLines.push(' ');
    renderedLines.push(theme.textBold('  Do you want to proceed?'));
    for (let i = 0; i < permissionOptions.length; i++) {
      const opt = permissionOptions[i];
      const isSelected = i === permissionMenuSelection;
      const pointer = isSelected ? theme.accent(`${icons.arrow} `) : '  ';
      const label = isSelected ? theme.textBold(stripAnsi(opt.label)) : theme.text(stripAnsi(opt.label));
      const num = theme.muted(`${i + 1}. `);
      renderedLines.push(`  ${pointer}${num}${label}`);
    }
    renderedLines.push('');
    renderedLines.push(
      theme.dim(`  Esc cancel ${icons.dot} Up/Down navigate ${icons.dot} Enter select ${icons.dot} y/a/n quick keys`)
    );
  }

  // Compute visible slice with scroll
  let startLine = 0;
  if (renderedLines.length > visibleRows) {
    const maxScroll = renderedLines.length - visibleRows;
    if (scrollOffset > 0) {
      const clamped = Math.min(scrollOffset, maxScroll);
      startLine = maxScroll - clamped;
    } else {
      startLine = maxScroll;
    }
  }

  const visible = renderedLines.slice(startLine, startLine + visibleRows);

  // Pad remaining rows with space lines to fill the area
  while (visible.length < visibleRows) {
    visible.push(' ');
  }

  return (
    <Box flexDirection="column" paddingLeft={2}>
      {visible.map((line, i) => (
        <Text key={i}>{line}</Text>
      ))}
    </Box>
  );
}
