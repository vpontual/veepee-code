import { createServer, type Server } from 'http';
import { spawn } from 'child_process';
import { readFile, stat } from 'fs/promises';
import { extname, join, resolve, dirname } from 'path';
import { existsSync } from 'fs';
import type { SandboxManager } from './sandbox.js';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain',
  '.md': 'text/plain',
  '.csv': 'text/csv',
  '.xml': 'application/xml',
  '.pdf': 'application/pdf',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.wasm': 'application/wasm',
};

const SCRIPT_RUNNERS: Record<string, string[]> = {
  '.py': ['python3'],
  '.sh': ['bash'],
  '.js': ['node'],
  '.mjs': ['node'],
  '.ts': ['npx', 'tsx'],
  '.rb': ['ruby'],
  '.pl': ['perl'],
  '.lua': ['lua'],
};

const SCRIPT_TIMEOUT = 30_000; // 30 seconds

export interface PreviewResult {
  type: 'output' | 'url';
  content: string;
}

export class PreviewManager {
  private server: Server | null = null;
  private serverPort: number | null = null;
  private serverRoot: string | null = null;
  private sandbox: SandboxManager;

  constructor(sandbox: SandboxManager) {
    this.sandbox = sandbox;
  }

  /** Run or preview a file. Returns output or URL. */
  async run(filePath: string): Promise<PreviewResult> {
    const resolved = resolve(filePath);
    if (!existsSync(resolved)) {
      throw new Error(`File not found: ${resolved}`);
    }

    const ext = extname(resolved).toLowerCase();

    // HTML files → serve via static server
    if (ext === '.html' || ext === '.htm') {
      const rootDir = dirname(resolved);
      const { url } = await this.startServer(rootDir);
      const filename = resolved.split('/').pop();
      const fullUrl = `${url}/${filename}`;
      this.openBrowser(fullUrl);
      return { type: 'url', content: fullUrl };
    }

    // Script files → execute
    const runner = SCRIPT_RUNNERS[ext];
    if (runner) {
      const output = await this.runScript(runner, resolved);
      return { type: 'output', content: output };
    }

    throw new Error(`Unsupported file type: ${ext}. Supported: ${[...Object.keys(SCRIPT_RUNNERS), '.html'].join(', ')}`);
  }

  /** Start a static file server in the given directory */
  async startServer(rootDir: string, port?: number): Promise<{ url: string; close: () => void }> {
    const resolvedRoot = resolve(rootDir);

    // Reuse existing server only for the same root
    if (this.server && this.serverPort && this.serverRoot === resolvedRoot) {
      return { url: `http://localhost:${this.serverPort}`, close: () => this.stopServer() };
    }

    if (this.server) {
      this.stopServer();
    }

    const startPort = port || 8485;

    return new Promise((resolvePromise, reject) => {
      const srv = createServer(async (req, res) => {
        const urlPath = decodeURIComponent(new URL(req.url || '/', 'http://localhost').pathname);
        const filePath = resolve(resolvedRoot, `.${urlPath}`);

        // Security: prevent directory traversal
        if (!filePath.startsWith(resolvedRoot)) {
          res.writeHead(403);
          res.end('Forbidden');
          return;
        }

        try {
          const s = await stat(filePath);
          if (!s.isFile()) {
            res.writeHead(404);
            res.end('Not found');
            return;
          }

          const ext = extname(filePath).toLowerCase();
          const mime = MIME_TYPES[ext] || 'application/octet-stream';
          const content = await readFile(filePath);

          res.writeHead(200, {
            'Content-Type': mime,
            'Content-Length': content.length,
            'Cache-Control': 'no-cache',
          });
          res.end(content);
        } catch {
          res.writeHead(404);
          res.end('Not found');
        }
      });

      // Try ports starting from startPort
      let currentPort = startPort;
      const tryListen = () => {
        srv.once('error', (err: NodeJS.ErrnoException) => {
          if (err.code === 'EADDRINUSE' && currentPort < startPort + 20) {
            currentPort++;
            tryListen();
          } else {
            reject(err);
          }
        });
        srv.listen(currentPort, '127.0.0.1', () => {
          this.server = srv;
          this.serverPort = currentPort;
          this.serverRoot = resolvedRoot;
          resolvePromise({
            url: `http://localhost:${currentPort}`,
            close: () => this.stopServer(),
          });
        });
      };
      tryListen();
    });
  }

  /** Stop the preview server */
  stopServer(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
      this.serverPort = null;
      this.serverRoot = null;
    }
  }

  /** Run a script with timeout and capture output */
  private runScript(runner: string[], filePath: string): Promise<string> {
    return new Promise((resolvePromise, reject) => {
      const [cmd, ...args] = runner;
      const proc = spawn(cmd, [...args, filePath], {
        cwd: dirname(filePath),
        timeout: SCRIPT_TIMEOUT,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
      proc.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

      proc.on('close', (code) => {
        const output = stdout + (stderr ? `\n--- stderr ---\n${stderr}` : '');
        if (code !== 0 && code !== null) {
          resolvePromise(`Exit code ${code}\n${output}`);
        } else {
          resolvePromise(output || '(no output)');
        }
      });

      proc.on('error', (err) => {
        reject(new Error(`Failed to run ${cmd}: ${err.message}`));
      });
    });
  }

  /** Open URL in default browser (cross-platform) */
  private openBrowser(url: string): void {
    const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
    spawn(cmd, [url], { detached: true, stdio: 'ignore' }).unref();
  }
}
