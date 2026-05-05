/**
 * file:// URI ↔ filesystem path conversion.
 *
 * Node's `url.pathToFileURL` does the right thing on POSIX and Windows but
 * returns a `URL` object; LSP wants the string form. We also need the
 * inverse for diagnostics that come back from the server. Wrap both in
 * tiny helpers so the call sites are obvious and the encoding is
 * consistent across the whole LSP module.
 */

import { pathToFileURL, fileURLToPath } from 'node:url';

export function pathToFileUri(absPath: string): string {
  return pathToFileURL(absPath).toString();
}

export function fileUriToPath(uri: string): string {
  return fileURLToPath(uri);
}
