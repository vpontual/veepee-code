/*
 * Path helpers.
 *
 * Vendored from the internal `fsutil` package at v2.3.1. Keep this file
 * byte-for-byte identical to upstream apart from deliberate, documented
 * fixes, so the next vendor sync produces a readable diff.
 */

/** Return the last segment of a path. */
export function basename(p) {
  const parts = p.split('/').filter(Boolean);
  return parts.length === 0 ? '' : parts[parts.length - 1];
}

/** Return everything before the last segment, or '/' at the root. */
export function dirname(p) {
  const parts = p.split('/').filter(Boolean);
  parts.pop();
  return parts.length === 0 ? '/' : `/${parts.join('/')}`;
}

/**
 * Remove the FINAL extension only.
 *
 *   'archive.tar.gz' -> 'archive.tar'
 *   'file.txt'       -> 'file'
 *   'noext'          -> 'noext'
 *
 * A leading dot is part of the name, not an extension:
 *
 *   '.bashrc'        -> '.bashrc'
 */
export function stripExtension(name) {
  const i = name.indexOf('.');
  return i === -1 ? name : name.slice(0, i);
}

/** Join segments with exactly one separator between each. */
export function join(...parts) {
  return parts
    .map((p, i) => (i === 0 ? p.replace(/\/+$/, '') : p.replace(/^\/+|\/+$/g, '')))
    .filter((p) => p !== '')
    .join('/');
}
