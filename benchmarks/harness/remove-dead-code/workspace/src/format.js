/**
 * @deprecated Use `format(bytes, { style: 'short' })` instead.
 *
 * Kept only until the last caller is migrated.
 */
export function formatLegacy(bytes) {
  return `${Math.round(bytes / 1024)}K`;
}

/**
 * Human-readable size.
 *
 * `style: 'short'` reproduces the old formatLegacy output exactly.
 */
export function format(bytes, { style = 'long' } = {}) {
  if (style === 'short') return `${Math.round(bytes / 1024)}K`;
  return `${(bytes / 1024).toFixed(1)} KiB`;
}
