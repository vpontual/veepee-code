import { formatLegacy } from './format.js';

export function statusLine(bytes) {
  return `using ${formatLegacy(bytes)}`;
}
