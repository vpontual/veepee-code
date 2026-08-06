import { formatLegacy } from './format.js';

export function sizeReport(entries) {
  return entries.map((e) => `${e.name} ${formatLegacy(e.bytes)}`).join('\n');
}
