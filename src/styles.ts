import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

export interface OutputStyle {
  name: string;
  description: string;
  prompt: string;
}

const STYLES_DIR = join(process.env.HOME || '~', '.veepee-code', 'output-styles');

/** Load all output styles from ~/.veepee-code/output-styles/ */
export function loadOutputStyles(): OutputStyle[] {
  if (!existsSync(STYLES_DIR)) return [];

  const styles: OutputStyle[] = [];
  try {
    for (const file of readdirSync(STYLES_DIR)) {
      if (!file.endsWith('.md')) continue;
      try {
        const raw = readFileSync(join(STYLES_DIR, file), 'utf-8');
        const { name, description, body } = parseFrontmatter(raw, file);
        if (body.trim()) {
          styles.push({ name, description, prompt: body.trim() });
        }
      } catch { /* skip bad files */ }
    }
  } catch { /* dir not readable */ }
  return styles;
}

/** Get a style by name */
export function getOutputStyle(name: string): OutputStyle | undefined {
  return loadOutputStyles().find(s => s.name.toLowerCase() === name.toLowerCase());
}

/** List available style names */
export function listOutputStyles(): string[] {
  return loadOutputStyles().map(s => s.name);
}

/** Create the styles directory with an example style */
export function initOutputStyles(): string {
  mkdirSync(STYLES_DIR, { recursive: true });

  const examplePath = join(STYLES_DIR, 'concise.md');
  if (!existsSync(examplePath)) {
    writeFileSync(examplePath, `---
name: concise
description: Ultra-brief responses, no fluff
---
Be extremely concise. One sentence answers when possible.
No preamble, no postamble, no filler words.
Use bullet points for lists. Code only in fenced blocks.
Never say "Great question" or "I'd be happy to help".
`);
  }

  return STYLES_DIR;
}

function parseFrontmatter(raw: string, filename: string): { name: string; description: string; body: string } {
  const lines = raw.split('\n');
  let name = filename.replace('.md', '');
  let description = '';
  let bodyStart = 0;

  if (lines[0]?.trim() === '---') {
    const endIdx = lines.indexOf('---', 1);
    if (endIdx > 0) {
      for (let i = 1; i < endIdx; i++) {
        const line = lines[i];
        const match = line.match(/^(\w+):\s*(.+)/);
        if (match) {
          if (match[1] === 'name') name = match[2].trim();
          if (match[1] === 'description') description = match[2].trim();
        }
      }
      bodyStart = endIdx + 1;
    }
  }

  return { name, description, body: lines.slice(bodyStart).join('\n') };
}
