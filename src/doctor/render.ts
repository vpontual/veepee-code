import chalk from 'chalk';
import type { DoctorSummary } from './types.js';

const ICONS = {
  ok: chalk.green('✓'),
  warn: chalk.yellow('⚠'),
  error: chalk.red('✗'),
  info: chalk.cyan('•'),
};

/** Render a DoctorSummary into a human-readable block. Output is grouped
 *  by category; failures get an indented detail line. */
export function renderDoctor(summary: DoctorSummary): string {
  const lines: string[] = [''];

  // Group results by category, preserving insertion order
  const byCategory = new Map<string, DoctorSummary['results']>();
  for (const r of summary.results) {
    const arr = byCategory.get(r.check.category) ?? [];
    arr.push(r);
    byCategory.set(r.check.category, arr);
  }

  for (const [category, items] of byCategory) {
    lines.push(chalk.bold(category));
    for (const { check, result } of items) {
      const icon = ICONS[result.severity];
      lines.push(`  ${icon} ${result.message} ${chalk.dim(`(${check.id})`)}`);
      if (result.detail) {
        for (const line of result.detail.split('\n')) {
          lines.push(`    ${chalk.dim(line)}`);
        }
      }
    }
    lines.push('');
  }

  // Summary footer
  const parts: string[] = [];
  if (summary.ok) parts.push(chalk.green(`${summary.ok} ok`));
  if (summary.warnings) parts.push(chalk.yellow(`${summary.warnings} warning${summary.warnings === 1 ? '' : 's'}`));
  if (summary.errors) parts.push(chalk.red(`${summary.errors} error${summary.errors === 1 ? '' : 's'}`));
  if (summary.info) parts.push(chalk.cyan(`${summary.info} info`));
  lines.push(`${chalk.bold('Summary:')} ${parts.join(', ')}`);

  // Highlight fixable errors/warnings
  const fixable = summary.results.filter((r) =>
    typeof r.check.fix === 'function' && (r.result.severity === 'error' || r.result.severity === 'warn'),
  );
  if (fixable.length > 0) {
    lines.push('');
    lines.push(chalk.dim(`${fixable.length} issue${fixable.length === 1 ? '' : 's'} can be fixed automatically. Run /doctor fix to apply.`));
  }

  return lines.join('\n');
}
