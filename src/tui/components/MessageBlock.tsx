import React from 'react';
import { Text } from 'ink';
import chalk from 'chalk';
import wrapAnsi from 'wrap-ansi';
import { highlight } from 'cli-highlight';
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

function highlightCode(code: string, lang?: string): string {
  try {
    return highlight(code, { language: lang || 'auto', ignoreIllegals: true });
  } catch {
    return chalk.hex('#E8A87C')(code);
  }
}

/**
 * Inline markdown to ANSI for a single line of prose (no fences here).
 * Handles inline code, bold (double star / double underscore), italic, links.
 * marked-terminal was removed (broken with marked v15 — it stripped the syntax
 * with no ANSI, or threw, leaking raw asterisks to the terminal). This hand-rolled
 * pass is version-proof and paired with wrap-ansi for ANSI-aware wrapping.
 */
function mdInline(s: string): string {
  // Protect inline code first so its contents aren't touched by other rules.
  const codes: string[] = [];
  s = s.replace(/`([^`]+)`/g, (_m, c) => {
    codes.push(chalk.hex('#E8A87C').bold(c));
    return `§${codes.length - 1}§`;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, (_m, t) => chalk.bold.white(t));
  s = s.replace(/__([^_]+)__/g, (_m, t) => chalk.bold.white(t));
  s = s.replace(/(?<![*\w])\*([^*\n]+)\*(?![*\w])/g, (_m, t) => chalk.italic(t));
  s = s.replace(/(?<![_\w])_([^_\n]+)_(?![_\w])/g, (_m, t) => chalk.italic(t));
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, t) => chalk.hex('#85C7F2').underline(t));
  return s.replace(/§(\d+)§/g, (_m, i) => codes[Number(i)]);
}

function formatAssistantMarkdown(content: string, maxWidth: number): string[] {
  const width = Math.max(8, maxWidth);
  const out: string[] = [];
  const wrap = (s: string, w = width): string[] => wrapAnsi(s, w, { hard: true, trim: false }).split('\n');
  let inFence = false;
  let fenceLang = '';
  let codeBuf: string[] = [];
  const flushCode = () => {
    if (codeBuf.length === 0) { return; }
    const border = chalk.dim('─'.repeat(Math.min(40, width)));
    out.push(border + (fenceLang ? chalk.dim(` ${fenceLang}`) : ''));
    for (const cl of highlightCode(codeBuf.join('\n'), fenceLang).split('\n')) { out.push(cl); }
    out.push(border);
    codeBuf = [];
  };
  for (const raw of content.split('\n')) {
    const fence = raw.match(/^\s*```(\w*)\s*$/);
    if (fence) {
      if (inFence) { flushCode(); inFence = false; fenceLang = ''; }
      else { inFence = true; fenceLang = fence[1] || ''; }
      continue;
    }
    if (inFence) { codeBuf.push(raw); continue; }
    if (raw.trim() === '') { out.push(''); continue; }
    const h = raw.match(/^(#{1,6})\s+(.*)$/);
    if (h) { out.push(...wrap(chalk.bold.underline.white(mdInline(h[2])))); continue; }
    if (/^\s*([-*_])\1\1+\s*$/.test(raw)) { out.push(chalk.dim('─'.repeat(Math.min(40, width)))); continue; }
    const bq = raw.match(/^\s*>\s?(.*)$/);
    if (bq) { out.push(...wrap(chalk.dim.italic(`▏ ${mdInline(bq[1])}`))); continue; }
    const li = raw.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
    if (li) {
      const [, indent, mark, rest] = li;
      const bullet = /^\d+\.$/.test(mark) ? chalk.hex('#85C7F2')(mark) : chalk.hex('#85C7F2')('•');
      const wrapped = wrap(mdInline(rest), Math.max(4, width - indent.length - 2));
      wrapped.forEach((wl, i) => out.push(`${indent}${i === 0 ? `${bullet} ` : '  '}${wl}`));
      continue;
    }
    out.push(...wrap(mdInline(raw)));
  }
  if (inFence) { flushCode(); }
  return out;
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
