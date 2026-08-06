import { format, formatLegacy } from './format.js';

export function logLine(name, bytes) {
  return `${name}: ${formatLegacy(bytes)} (${format(bytes)})`;
}
