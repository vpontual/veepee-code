import { execSync, spawn } from 'child_process';
import { resolve } from 'path';

export interface UpdateStatus {
  available: boolean;
  current: string;
  latest: string;
  behind: number;
}

/** Where vcode is installed. install.sh honours VEEPEE_CODE_DIR, so hardcoding
 *  ~/.veepee-code meant any custom install never detected updates. */
function installDirectory(): string {
  return process.env.VEEPEE_CODE_DIR
    ? resolve(process.env.VEEPEE_CODE_DIR)
    : resolve(process.env.HOME || '~', '.veepee-code');
}

/**
 * Check whether a newer version is on the remote.
 *
 * ASYNC and off the main thread. This used to be execSync wrapped in
 * setTimeout(…, 0), which does not make it non-blocking: execSync freezes the
 * event loop — and therefore the whole Ink TUI — for up to the fetch timeout,
 * plus unbounded time in the three untimed git calls that followed. Every step
 * is now spawned with its own timeout, and killed by process group so a hung
 * `git-remote-https` child cannot outlive its parent.
 */
export async function checkForUpdate(): Promise<UpdateStatus | null> {
  const cwd = installDirectory();

  const git = (args: string[], timeoutMs: number): Promise<string | null> =>
    new Promise((resolveP) => {
      const proc = spawn('git', args, { cwd, detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      let settled = false;
      const done = (v: string | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        proc.stdout?.destroy();
        resolveP(v);
      };
      const timer = setTimeout(() => {
        try {
          if (proc.pid !== undefined) process.kill(-proc.pid, 'SIGKILL');
        } catch { /* already gone */ }
        done(null);
      }, timeoutMs);
      proc.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
      proc.on('close', (code) => done(code === 0 ? out.trim() : null));
      proc.on('error', () => done(null));
    });

  try {
    if (await git(['fetch', '--quiet', 'origin', 'main'], 5000) === null) return null;

    const local = await git(['rev-parse', 'HEAD'], 3000);
    const remote = await git(['rev-parse', 'origin/main'], 3000);
    if (!local || !remote) return null;

    if (local === remote) {
      return { available: false, current: local.slice(0, 7), latest: remote.slice(0, 7), behind: 0 };
    }

    const behindRaw = await git(['rev-list', '--count', 'HEAD..origin/main'], 3000);
    const behind = behindRaw ? parseInt(behindRaw, 10) : 0;

    return { available: true, current: local.slice(0, 7), latest: remote.slice(0, 7), behind };
  } catch {
    return null; // network error, not a git repo, etc. — silently skip
  }
}
