import React from 'react';
import { Text } from 'ink';
import chalk from 'chalk';
import { marked } from 'marked';
import { markedTerminal } from 'marked-terminal';
import { theme, icons } from '../theme.js';
import type { Message } from '../types.js';

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

function truncateStr(text: string, maxWidth: number): string {
  const stripped = stripAnsi(text);
  if (stripped.length <= maxWidth) return text;
  return stripped.slice(0, maxWidth - 1) + '…';
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

function setupMarkedTerminal(width: number): void {
  marked.use(markedTerminal({
    code: chalk.hex('#E8A87C'),
    codespan: chalk.hex('#E8A87C').bold,
    strong: chalk.bold.white,
    em: chalk.italic,
    heading: chalk.bold.underline.white,
    listitem: chalk.white,
    link: chalk.hex('#85C7F2').underline,
    paragraph: chalk.white,
    hr: () => chalk.dim('─'.repeat(Math.min(40, width - 4))) + '\n',
    blockquote: chalk.dim.italic,
    width,
    reflowText: true,
    tab: 2,
  }) as never);
}

function formatAssistantMarkdown(content: string, maxWidth: number): string[] {
  try {
    setupMarkedTerminal(maxWidth);
    const rendered = (marked.parse(content) as string).replace(/\n+$/, '');
    const lines: string[] = [];
    for (const line of rendered.split('\n')) {
      const visualLen = stripAnsi(line).length;
      if (visualLen <= maxWidth) {
        lines.push(line);
      } else {
        lines.push(...wordWrap(stripAnsi(line), maxWidth));
      }
    }
    return lines;
  } catch {
    return wordWrap(content, maxWidth).map(line => chalk.white(line));
  }
}

export function formatMessage(msg: Message, maxWidth: number): string[] {
  switch (msg.role) {
    case 'user': {
      const contentWidth = maxWidth - 3;
      const wrapped = wordWrap(msg.content, contentWidth);
      const bg = chalk.bgHex('#2A2A4A');
      return wrapped.map(wl => {
        const padded = wl + ' '.repeat(Math.max(0, contentWidth - stripAnsi(wl).length));
        return bg(chalk.hex('#85C7F2')('│') + ' ' + chalk.white.bold(padded));
      });
    }

    case 'assistant': {
      // Bullet prefix on first line, indent continuation lines to match
      const lines = formatAssistantMarkdown(msg.content, maxWidth - 4);
      return lines.map((l, i) =>
        i === 0
          ? `${theme.accent(icons.dot)} ${l}`    // ● first line
          : `  ${l}`                               // align with text after bullet
      );
    }

    case 'tool_call':
      return [theme.tool(`${icons.tool} `) + theme.muted(truncateStr(msg.content, maxWidth - 3))];

    case 'tool_result': {
      const icon = msg.success ? theme.success(icons.check) : theme.error(icons.cross);
      const lines = msg.content.split('\n').slice(0, 8);
      return lines.map((line, i) => {
        const prefix = i === 0 ? `  ${icon} ` : '    ';
        if (line.startsWith('+ ')) {
          return prefix + chalk.green(truncateStr(line, maxWidth - 6));
        } else if (line.startsWith('- ')) {
          return prefix + chalk.red(truncateStr(line, maxWidth - 6));
        }
        return prefix + theme.muted(truncateStr(line, maxWidth - 6));
      });
    }

    case 'thinking': {
      if (msg.content === '...') {
        const frames = ['◐', '◓', '◑', '◒'];
        const frame = frames[Math.floor(Date.now() / 200) % frames.length];
        return [theme.muted(`  ${frame} Thinking...`)];
      }
      const thinkLines = msg.content.split('\n');
      const preview = thinkLines[0].slice(0, maxWidth - 20);
      const lineCount = thinkLines.length;
      if (msg.collapsed && lineCount > 1) {
        return [
          theme.muted(`  ${icons.thinking} Thought (${lineCount} lines) `) + theme.dim(truncateStr(preview, maxWidth - 30)),
        ];
      }
      return thinkLines.slice(0, 20).map(l => theme.dim(`  │ ${truncateStr(l, maxWidth - 6)}`));
    }

    case 'model_switch':
      return [theme.warning(`  ${icons.thinking} Model: ${msg.content}`)];

    case 'system':
      return msg.content.split('\n').map(line => theme.muted(`  ${line}`));

    default:
      return [msg.content];
  }
}

interface MessageBlockProps {
  message: Message;
  maxWidth: number;
}

export function MessageBlock({ message, maxWidth }: MessageBlockProps): React.ReactElement {
  const lines = formatMessage(message, maxWidth);
  return (
    <>
      {lines.map((line, i) => (
        <Text key={i}>{line}</Text>
      ))}
    </>
  );
}
