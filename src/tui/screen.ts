/** Low-level terminal screen primitives */

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
  process.stdout.write('\x1b[?25h');
}

export function hideCursor(): void {
  process.stdout.write('\x1b[?25l');
}

export function moveTo(row: number, col: number): void {
  process.stdout.write(`\x1b[${row};${col}H`);
}

export function clearLine(): void {
  process.stdout.write('\x1b[2K');
}

export function clearScreen(): void {
  process.stdout.write('\x1b[2J\x1b[H');
}

export function clearBelow(): void {
  process.stdout.write('\x1b[J');
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
  process.stdout.write(text);
}

/** Draw a horizontal line */
export function hline(row: number, col: number, width: number, char = '─'): void {
  moveTo(row, col);
  process.stdout.write(char.repeat(width));
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
