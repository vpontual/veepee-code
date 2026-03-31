import React from 'react';
import { Text } from 'ink';
import chalk from 'chalk';
import { theme, icons } from '../theme.js';

interface DiffViewProps {
  fileName: string;
  oldContent: string;
  newContent: string;
  maxWidth: number;
}

interface DiffLine {
  type: 'context' | 'add' | 'remove' | 'header';
  lineNum?: number;
  text: string;
}

/** Generate unified diff lines from old and new content */
function computeDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const result: DiffLine[] = [];

  // Simple LCS-based diff
  const maxLen = Math.max(oldLines.length, newLines.length);
  let oi = 0, ni = 0;

  while (oi < oldLines.length || ni < newLines.length) {
    if (oi < oldLines.length && ni < newLines.length && oldLines[oi] === newLines[ni]) {
      result.push({ type: 'context', lineNum: ni + 1, text: oldLines[oi] });
      oi++; ni++;
    } else if (ni < newLines.length && (oi >= oldLines.length || !oldLines.slice(oi).includes(newLines[ni]))) {
      result.push({ type: 'add', lineNum: ni + 1, text: newLines[ni] });
      ni++;
    } else if (oi < oldLines.length) {
      result.push({ type: 'remove', lineNum: oi + 1, text: oldLines[oi] });
      oi++;
    }

    if (result.length > maxLen * 2 + 50) break; // safety limit
  }

  return result;
}

/** Structured diff display for file edits */
export function DiffView({ fileName, oldContent, newContent, maxWidth }: DiffViewProps): React.ReactElement {
  const diff = computeDiff(oldContent, newContent);
  const contentWidth = maxWidth - 8; // line number + prefix

  // Only show lines near changes (context of 2)
  const changedIndices = new Set<number>();
  diff.forEach((line, i) => {
    if (line.type === 'add' || line.type === 'remove') {
      for (let j = Math.max(0, i - 2); j <= Math.min(diff.length - 1, i + 2); j++) {
        changedIndices.add(j);
      }
    }
  });

  const visibleLines = diff
    .map((line, i) => ({ ...line, visible: changedIndices.has(i), idx: i }))
    .filter(l => l.visible);

  // Insert separators between non-contiguous ranges
  const output: DiffLine[] = [];
  for (let i = 0; i < visibleLines.length; i++) {
    if (i > 0 && visibleLines[i].idx - visibleLines[i - 1].idx > 1) {
      output.push({ type: 'header', text: '···' });
    }
    output.push(visibleLines[i]);
  }

  return (
    <>
      <Text>{theme.accent(`  ${icons.tool} ${fileName}`)}</Text>
      {output.map((line, i) => {
        const num = line.lineNum ? chalk.dim(String(line.lineNum).padStart(4)) + ' ' : '     ';
        const text = line.text.slice(0, contentWidth);

        switch (line.type) {
          case 'add':
            return <Text key={i}>{num}{chalk.green(`+ ${text}`)}</Text>;
          case 'remove':
            return <Text key={i}>{num}{chalk.red(`- ${text}`)}</Text>;
          case 'header':
            return <Text key={i}>{theme.dim('     ···')}</Text>;
          default:
            return <Text key={i}>{num}{chalk.dim(`  ${text}`)}</Text>;
        }
      })}
    </>
  );
}

/** Format a diff string for inline display in messages */
export function formatDiffOutput(fileName: string, oldContent: string, newContent: string, maxWidth: number): string[] {
  const diff = computeDiff(oldContent, newContent);
  const contentWidth = maxWidth - 10;
  const lines: string[] = [];

  lines.push(theme.accent(`  ${icons.tool} ${fileName}`));

  // Only show changed lines with 1 line of context
  const changedIndices = new Set<number>();
  diff.forEach((line, i) => {
    if (line.type === 'add' || line.type === 'remove') {
      for (let j = Math.max(0, i - 1); j <= Math.min(diff.length - 1, i + 1); j++) {
        changedIndices.add(j);
      }
    }
  });

  let lastIdx = -2;
  for (let i = 0; i < diff.length; i++) {
    if (!changedIndices.has(i)) continue;

    if (i - lastIdx > 1 && lastIdx >= 0) {
      lines.push(theme.dim('     ···'));
    }

    const line = diff[i];
    const num = line.lineNum ? chalk.dim(String(line.lineNum).padStart(4)) + ' ' : '     ';
    const text = line.text.slice(0, contentWidth);

    if (line.type === 'add') {
      lines.push(num + chalk.green(`+ ${text}`));
    } else if (line.type === 'remove') {
      lines.push(num + chalk.red(`- ${text}`));
    } else {
      lines.push(num + chalk.dim(`  ${text}`));
    }

    lastIdx = i;
  }

  const adds = diff.filter(l => l.type === 'add').length;
  const removes = diff.filter(l => l.type === 'remove').length;
  lines.push(theme.dim(`     ${chalk.green(`+${adds}`)} ${chalk.red(`-${removes}`)}`));

  return lines;
}
