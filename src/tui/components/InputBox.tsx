import React from 'react';
import { Box, Text } from 'ink';
import chalk from 'chalk';
import { theme, box, icons } from '../theme.js';
import type { InputState } from '../types.js';

interface InputBoxProps {
  input: InputState;
  modelName: string;
  modelSize: string;
  modelRole: string;
  providerName: string;
  isWaiting: boolean;        // agent is running, no resolveInput
  hasResolveInput: boolean;  // whether getInput() is active
  queuedInput: string;
  queuedCursor: number;
  cols: number;
}

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

function truncateStr(text: string, maxWidth: number): string {
  const stripped = stripAnsi(text);
  if (stripped.length <= maxWidth) return text;
  return stripped.slice(0, maxWidth - 1) + '…';
}

/** Render text with a solid block cursor at the given position */
function renderWithCursor(text: string, cursorPos: number, width: number): string {
  // Compute visible window
  let viewStart = 0;
  if (cursorPos > width - 1) {
    viewStart = cursorPos - width + 1;
  }
  const viewText = text.slice(viewStart, viewStart + width).replace(/\n/g, '↵');
  const cursorInView = cursorPos - viewStart;

  // Build: before cursor + inverted cursor char + after cursor
  const before = viewText.slice(0, cursorInView);
  const cursorChar = cursorInView < viewText.length ? viewText[cursorInView] : ' ';
  const after = viewText.slice(cursorInView + 1);

  const rendered = before + chalk.inverse(cursorChar) + after;
  const visLen = stripAnsi(before).length + 1 + stripAnsi(after).length;
  const pad = Math.max(0, width - visLen);
  return rendered + ' '.repeat(pad);
}

export function InputBox({
  input, modelName, modelSize, modelRole, providerName,
  isWaiting, hasResolveInput, queuedInput, queuedCursor, cols,
}: InputBoxProps): React.ReactElement {
  const boxWidth = cols - 4;
  const contentWidth = boxWidth - 4;

  // Build input line content
  const isQueuing = isWaiting && queuedInput.length > 0;

  let displayLine: string;

  if (isQueuing) {
    // Queued text with indicator + cursor
    const label = chalk.hex('#E8A87C')('⏳ ');
    const availWidth = contentWidth - 3; // account for emoji+space
    const truncated = queuedInput.length > availWidth ? queuedInput.slice(0, availWidth - 1) + '…' : queuedInput;
    const textPart = truncated.replace(/\n/g, '↵');
    // Insert cursor
    const before = textPart.slice(0, queuedCursor);
    const cursorChar = queuedCursor < textPart.length ? textPart[queuedCursor] : ' ';
    const after = textPart.slice(queuedCursor + 1);
    const rendered = before + chalk.inverse(cursorChar) + after;
    const visLen = before.length + 1 + after.length;
    displayLine = label + rendered + ' '.repeat(Math.max(0, availWidth - visLen));
  } else if (hasResolveInput && input.text) {
    // Active input with cursor
    displayLine = renderWithCursor(input.text, input.cursor, contentWidth);
  } else if (hasResolveInput) {
    // Empty input — show placeholder with cursor at start
    const placeholderText = 'Ask anything... "Fix the bug in auth.ts"';
    const visual = placeholderText.slice(0, contentWidth);
    // Show cursor block on first char, rest dimmed
    displayLine = chalk.gray.inverse(visual[0]) + chalk.gray(visual.slice(1)) + ' '.repeat(Math.max(0, contentWidth - visual.length));
  } else if (isWaiting) {
    // Agent running, no queued text — dim hint, no cursor
    const hint = 'Type ahead — your message will send when the model finishes';
    const visual = hint.slice(0, contentWidth);
    const padding = ' '.repeat(Math.max(0, contentWidth - visual.length));
    displayLine = chalk.gray(visual) + padding;
  } else {
    // Fallback — dim placeholder, no cursor
    const placeholderText = 'Ask anything... "Fix the bug in auth.ts"';
    const visual = placeholderText.slice(0, contentWidth);
    const padding = ' '.repeat(Math.max(0, contentWidth - visual.length));
    displayLine = chalk.gray(visual) + padding;
  }

  // Model info line
  const modelInfo = `${theme.accent(modelRole)}  ${theme.text(modelName)} ${theme.muted(modelSize)} ${theme.muted('(default)')} ${theme.dim(providerName)}`;
  const modelInfoClean = stripAnsi(modelInfo);
  const modelPadded = modelInfoClean.length < contentWidth
    ? modelInfo + ' '.repeat(contentWidth - modelInfoClean.length)
    : truncateStr(modelInfo, contentWidth);

  // Borders
  const topBorder = theme.borderFocused(box.roundTl + box.h.repeat(boxWidth - 2) + box.roundTr);
  const bottomBorder = theme.borderFocused(box.roundBl + box.h.repeat(boxWidth - 2) + box.roundBr);

  // Hints
  const hints = `${theme.textBold('tab')} ${theme.muted('tools')}  ${theme.textBold('ctrl+p')} ${theme.muted('commands')}  ${theme.textBold('/help')} ${theme.muted('help')}`;

  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Text>{topBorder}</Text>
      <Text>{theme.borderFocused(box.v)} {displayLine} {theme.borderFocused(box.v)}</Text>
      <Text>{theme.borderFocused(box.v)} {modelPadded} {theme.borderFocused(box.v)}</Text>
      <Text>{bottomBorder}</Text>
      <Box justifyContent="center" paddingLeft={2}>
        <Text>{hints}</Text>
      </Box>
    </Box>
  );
}
