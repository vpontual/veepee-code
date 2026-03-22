import { execSync } from 'child_process';
import { resolve } from 'path';

export interface UpdateStatus {
  available: boolean;
  current: string;
  latest: string;
  behind: number;
}

/** Check if a newer version is available on the remote. Non-blocking, fast. */
export function checkForUpdate(): UpdateStatus | null {
  const installDir = resolve(process.env.HOME || '~', '.veepee-code');

  try {
    // Fetch remote refs without downloading objects (fast, ~200ms)
    execSync('git fetch --quiet origin main', { cwd: installDir, timeout: 5000, stdio: 'ignore' });

    const local = execSync('git rev-parse HEAD', { cwd: installDir, encoding: 'utf-8' }).trim();
    const remote = execSync('git rev-parse origin/main', { cwd: installDir, encoding: 'utf-8' }).trim();

    if (local === remote) {
      return { available: false, current: local.slice(0, 7), latest: remote.slice(0, 7), behind: 0 };
    }

    // Count commits behind
    const behind = parseInt(
      execSync(`git rev-list --count HEAD..origin/main`, { cwd: installDir, encoding: 'utf-8' }).trim(),
      10,
    );

    return { available: true, current: local.slice(0, 7), latest: remote.slice(0, 7), behind };
  } catch {
    return null; // network error, not a git repo, etc. — silently skip
  }
}
