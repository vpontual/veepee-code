import { formatDuration } from './format.js';

export function summarize(runs) {
  return runs.map((r) => `${r.name}: ${formatDuration(r.ms)}`).join('\n');
}

export function verboseSummary(runs) {
  return runs.map((r) => `${r.name}: ${formatDuration(r.ms, true, true)}`).join('\n');
}

export function timestampRow(r) {
  return `${r.name}\t${formatDuration(r.ms, false, false, true)}`;
}
