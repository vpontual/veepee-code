/** Low-level terminal screen primitives */

// ─── Write buffer for flicker-free rendering ─────────────────────────────────
// When buffering is active, all terminal writes are collected into a single
// string and flushed at once, so the terminal never sees an intermediate
// (blank) frame.
let _buf: string[] | null = null;

/** Begin buffering all terminal writes. */
export function beginBuffer(): void {
  _buf = [];
}

/** Flush the buffer to stdout in a single write and stop buffering. */
export function flushBuffer(): void {
  if (_buf) {
    const data = _buf.join('');
    _buf = null;
    process.stdout.write(data);
  }
}

/** Internal: write to buffer or stdout. */
function out(s: string): void {
  if (_buf) _buf.push(s);
  else process.stdout.write(s);
}

export function enterAltScreen(): void {
  process.stdout.write('\x1b[?1049h'); // switch to alternate buffer
  process.stdout.write('\x1b[?25l');   // hide cursor
  process.stdout.write('\x1b[2J');     // clear
  process.stdout.write('\x1b[H');      // home
}

export function exitAltScreen(): void {
  process.stdout.write('\x1b[?25h');   // show cursor
  process.stdout.write('\x1b[?1049l'); // restore main buffer
}

export function showCursor(): void {
  out('\x1b[?25h');
}

export function hideCursor(): void {
  out('\x1b[?25l');
}

export function moveTo(row: number, col: number): void {
  out(`\x1b[${row};${col}H`);
}

export function clearLine(): void {
  out('\x1b[2K');
}

export function clearScreen(): void {
  out('\x1b[2J\x1b[H');
}

export function clearBelow(): void {
  out('\x1b[J');
}

export function getSize(): { rows: number; cols: number } {
  return {
    rows: process.stdout.rows || 24,
    cols: process.stdout.columns || 80,
  };
}

/** Write text at a specific position */
export function writeAt(row: number, col: number, text: string): void {
  moveTo(row, col);
  out(text);
}

/** Draw a horizontal line */
export function hline(row: number, col: number, width: number, char = '─'): void {
  moveTo(row, col);
  out(char.repeat(width));
}

/** Strip ANSI escape codes for length calculation */
export function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

/** Center text within a given width */
export function center(text: string, width: number): string {
  const textLen = stripAnsi(text).length;
  if (textLen >= width) return text;
  const left = Math.floor((width - textLen) / 2);
  return ' '.repeat(left) + text;
}

/** Right-align text within a given width */
export function rightAlign(text: string, width: number): string {
  const textLen = stripAnsi(text).length;
  if (textLen >= width) return text;
  return ' '.repeat(width - textLen) + text;
}

/** Truncate text to fit width, adding ellipsis */
export function truncate(text: string, maxWidth: number): string {
  const stripped = stripAnsi(text);
  if (stripped.length <= maxWidth) return text;
  return stripped.slice(0, maxWidth - 1) + '…';
}

/** Word-wrap text to fit within maxWidth */
export function wordWrap(text: string, maxWidth: number): string[] {
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
