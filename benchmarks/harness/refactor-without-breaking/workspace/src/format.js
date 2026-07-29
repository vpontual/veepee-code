export function formatDuration(ms, long = false, showMs = false, pad = false) {
  const totalSeconds = Math.floor(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;

  const two = (n) => (pad ? String(n).padStart(2, '0') : String(n));
  const parts = [];
  if (h > 0) parts.push(long ? `${h} hours` : `${two(h)}h`);
  if (m > 0 || h > 0) parts.push(long ? `${m} minutes` : `${two(m)}m`);
  parts.push(long ? `${s} seconds` : `${two(s)}s`);

  let out = parts.join(long ? ', ' : ' ');
  if (showMs) out += long ? `, ${ms % 1000} milliseconds` : ` ${ms % 1000}ms`;
  return out;
}
