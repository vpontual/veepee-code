import { writeFileSync, renameSync, unlinkSync } from 'fs';

/**
 * Write a file so readers never observe a partial one.
 *
 * A plain writeFileSync truncates the target and then fills it, so a crash, a
 * kill, or a full disk between those two steps leaves a truncated file. For
 * config that matters: a half-written `settings.json` loses the API token and
 * the model lock, and the next start silently falls back to defaults.
 *
 * Writing a sibling temp file and renaming avoids that — rename is atomic
 * within a filesystem, so the target is always either the old contents or the
 * complete new contents. The temp file is a sibling (not in /tmp) precisely so
 * the rename stays on one filesystem.
 *
 * Caller is responsible for the parent directory existing, as with writeFileSync.
 */
export function writeFileAtomicSync(path: string, data: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, data);
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* nothing to clean up */ }
    throw err;
  }
}
