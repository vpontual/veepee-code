import React from 'react';
import { Text } from 'ink';
import chalk from 'chalk';
import wrapAnsi from 'wrap-ansi';
import stringWidth from 'string-width';
import { highlight } from 'cli-highlight';
import { theme, icons } from '../theme.js';
import type { Message } from '../types.js';

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

/** Terminal columns a string occupies. Not the same as `.length`: CJK and
 *  emoji are one JS char but two columns, so measuring with `.length`
 *  under-counts and any padding built from it comes out short. */
function displayWidth(text: string): number {
  return stringWidth(stripAnsi(text));
}

function truncateStr(text: string, maxWidth: number): string {
  const stripped = stripAnsi(text);
  if (displayWidth(stripped) <= maxWidth) return text;
  // Trim by column, not by index, so a wide glyph can't overshoot the budget.
  let out = '';
  let w = 0;
  for (const ch of stripped) {
    const cw = stringWidth(ch);
    if (w + cw > maxWidth - 1) break;
    out += ch;
    w += cw;
  }
  return out + '…';
}

function wordWrap(text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    if (displayWidth(paragraph) <= maxWidth) {
      lines.push(paragraph);
      continue;
    }
    let line = '';
    for (const word of paragraph.split(/(\s+)/)) {
      if (displayWidth(line + word) > maxWidth) {
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

/** Placeholder wrapper for extracted inline code. NUL cannot appear in model
 *  output, unlike a printable marker such as the section sign, which a model
 *  can legitimately emit and which used to be substituted back out as the
 *  literal string "undefined". */
const CODE_SENTINEL = '\u0000';
const CODE_SENTINEL_RE = /\u0000(\d+)\u0000/g;

/**
 * Inline markdown to ANSI for a single line of prose (no fences here).
 * Handles inline code, bold (double star / double underscore), italic, links.
 * marked-terminal was removed (broken with marked v15 — it stripped the syntax
 * with no ANSI, or threw, leaking raw asterisks to the terminal). This hand-rolled
 * pass is version-proof and paired with wrap-ansi for ANSI-aware wrapping.
 */
function mdInline(s: string): string {
  // Protect inline code first so its contents aren't touched by other rules.
  // The placeholder uses NUL, which cannot occur in model output, rather than
  // a printable marker: `§0§` is text a model can legitimately emit (statute
  // references, for one), and it used to be substituted back out — yielding
  // the literal string "undefined" when the index didn't exist.
  const codes: string[] = [];
  s = s.replace(/`([^`]+)`/g, (_m, c) => {
    codes.push(chalk.hex('#E8A87C').bold(c));
    return `${CODE_SENTINEL}${codes.length - 1}${CODE_SENTINEL}`;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, (_m, t) => chalk.bold.white(t));
  s = s.replace(/__([^_]+)__/g, (_m, t) => chalk.bold.white(t));
  s = s.replace(/(?<![*\w])\*([^*\n]+)\*(?![*\w])/g, (_m, t) => chalk.italic(t));
  s = s.replace(/(?<![_\w])_([^_\n]+)_(?![_\w])/g, (_m, t) => chalk.italic(t));
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, t) => chalk.hex('#85C7F2').underline(t));
  return s.replace(CODE_SENTINEL_RE, (_m, i) => codes[Number(i)] ?? _m);
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

export const SPINNER_FRAMES = ['◐', '◓', '◑', '◒'];

/** Max lines of a tool result rendered inline before it is clipped. */
const TOOL_RESULT_MAX_LINES = 8;

/**
 * Rendered-line cache, keyed on message identity.
 *
 * The reducer treats messages as immutable — every action builds a new array
 * but reuses the objects for unchanged entries — so object identity is an
 * exact "this message's rendering cannot have changed" signal. Without this,
 * every render re-ran markdown parsing and syntax highlighting over the whole
 * history; at the 500-message cap that measured 62ms for plain prose and
 * ~680ms for code-heavy history, on every render, while streaming re-renders
 * per chunk.
 *
 * A WeakMap means trimmed-away messages are collected with no bookkeeping.
 */
const renderCache = new WeakMap<Message, { width: number; lines: string[] }>();

export function formatMessage(msg: Message, maxWidth: number, spinnerFrame = 0): string[] {
  // The spinner is the one message whose output legitimately varies for a
  // fixed message object, so it is never cached. It is a single line.
  const cacheable = !(msg.role === 'thinking' && msg.content === '...');
  if (cacheable) {
    const hit = renderCache.get(msg);
    if (hit && hit.width === maxWidth) return hit.lines;
  }
  const lines = formatMessageUncached(msg, maxWidth, spinnerFrame);
  if (cacheable) renderCache.set(msg, { width: maxWidth, lines });
  return lines;
}

function formatMessageUncached(msg: Message, maxWidth: number, spinnerFrame: number): string[] {
  switch (msg.role) {
    case 'user': {
      const contentWidth = maxWidth - 3;
      const wrapped = wordWrap(msg.content, contentWidth);
      const bg = chalk.bgHex('#2A2A4A');
      return wrapped.map(wl => {
        const padded = wl + ' '.repeat(Math.max(0, contentWidth - displayWidth(wl)));
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
      const allLines = msg.content.split('\n');
      const lines = allLines.slice(0, TOOL_RESULT_MAX_LINES);
      const out = lines.map((line, i) => {
        const prefix = i === 0 ? `  ${icon} ` : '    ';
        if (line.startsWith('+ ')) {
          return prefix + chalk.green(truncateStr(line, maxWidth - 6));
        } else if (line.startsWith('- ')) {
          return prefix + chalk.red(truncateStr(line, maxWidth - 6));
        }
        return prefix + theme.muted(truncateStr(line, maxWidth - 6));
      });
      // Say so when output was clipped — silently showing the first 8 lines
      // reads as "that was the whole result".
      const hidden = allLines.length - lines.length;
      if (hidden > 0) {
        out.push(`    ${theme.dim(`… ${hidden} more line${hidden === 1 ? '' : 's'}`)}`);
      }
      return out;
    }

    case 'thinking': {
      if (msg.content === '...') {
        // The frame index is an argument, not a clock read: rendering has to be
        // a pure function of its inputs to be safely cacheable, and reading the
        // clock here never animated anything anyway — it only changed when some
        // unrelated state happened to trigger a re-render.
        return [theme.muted(`  ${SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length]} Thinking...`)];
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
