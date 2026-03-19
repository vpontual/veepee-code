import { readFile, writeFile, readdir } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import { request as httpsRequest } from 'https';
import { request as httpRequest } from 'http';
import { getSessionDir } from './sessions.js';

export class SyncManager {
  private url: string;
  private user: string;
  private pass: string;
  private autoSync = false;

  constructor(url: string, user: string, pass: string) {
    // Ensure URL ends with /
    this.url = url.endsWith('/') ? url : url + '/';
    this.user = user;
    this.pass = pass;
  }

  /** Push session(s) to WebDAV. If sessionId is given, push only that session. */
  async push(sessionId?: string): Promise<void> {
    // Ensure remote directory exists
    await this.webdavMkcol(this.url);

    const sessionsDir = getSessionDir();
    if (!existsSync(sessionsDir)) return;

    const files = await readdir(sessionsDir);
    const targets = sessionId
      ? files.filter(f => f.startsWith(sessionId))
      : files.filter(f => f.endsWith('.json'));

    for (const file of targets) {
      const content = await readFile(join(sessionsDir, file), 'utf-8');
      await this.webdavPut(`${this.url}${file}`, content);
    }

    // Also push knowledge state files
    const ksFiles = sessionId
      ? files.filter(f => f.startsWith(sessionId) && f.endsWith('-knowledge.json'))
      : files.filter(f => f.endsWith('-knowledge.json'));

    for (const file of ksFiles) {
      if (!targets.includes(file)) {
        const content = await readFile(join(sessionsDir, file), 'utf-8');
        await this.webdavPut(`${this.url}${file}`, content);
      }
    }
  }

  /** Pull sessions from WebDAV. Returns count of updated files. */
  async pull(sessionId?: string): Promise<number> {
    const sessionsDir = getSessionDir();

    // List remote files
    const remoteFiles = await this.webdavPropfind(this.url);
    let updated = 0;

    for (const remote of remoteFiles) {
      if (!remote.name.endsWith('.json')) continue;
      if (sessionId && !remote.name.startsWith(sessionId)) continue;

      const localPath = join(sessionsDir, remote.name);

      // Conflict resolution: compare updatedAt, newer wins
      if (existsSync(localPath)) {
        try {
          const localData = JSON.parse(await readFile(localPath, 'utf-8'));
          if (localData.updatedAt && remote.lastModified) {
            const localTime = new Date(localData.updatedAt).getTime();
            const remoteTime = new Date(remote.lastModified).getTime();
            if (localTime >= remoteTime) continue; // local is newer
          }
        } catch { /* overwrite on parse error */ }
      }

      // Download
      const content = await this.webdavGet(`${this.url}${remote.name}`);
      await writeFile(localPath, content);
      updated++;
    }

    return updated;
  }

  /** Toggle auto-sync */
  setAutoSync(enabled: boolean): void {
    this.autoSync = enabled;
  }

  /** Check if auto-sync is enabled */
  isAutoSync(): boolean {
    return this.autoSync;
  }

  // ─── WebDAV Helpers ───────────────────────────────────────────────

  private getAuth(): string {
    return Buffer.from(`${this.user}:${this.pass}`).toString('base64');
  }

  private getRequestFn(url: string) {
    return url.startsWith('https') ? httpsRequest : httpRequest;
  }

  /** PUT a file to WebDAV */
  private webdavPut(url: string, body: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const reqFn = this.getRequestFn(url);
      const req = reqFn({
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname,
        method: 'PUT',
        headers: {
          'Authorization': `Basic ${this.getAuth()}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      }, (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve();
          } else {
            reject(new Error(`PUT ${url}: ${res.statusCode} ${data.slice(0, 200)}`));
          }
        });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  /** GET a file from WebDAV */
  private webdavGet(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const reqFn = this.getRequestFn(url);
      const req = reqFn({
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname,
        method: 'GET',
        headers: {
          'Authorization': `Basic ${this.getAuth()}`,
        },
      }, (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode === 200) {
            resolve(data);
          } else {
            reject(new Error(`GET ${url}: ${res.statusCode}`));
          }
        });
      });
      req.on('error', reject);
      req.end();
    });
  }

  /** PROPFIND to list directory contents */
  private webdavPropfind(url: string): Promise<Array<{ name: string; lastModified: string }>> {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const reqFn = this.getRequestFn(url);
      const req = reqFn({
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname,
        method: 'PROPFIND',
        headers: {
          'Authorization': `Basic ${this.getAuth()}`,
          'Depth': '1',
          'Content-Type': 'application/xml',
        },
      }, (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode === 207 || res.statusCode === 200) {
            resolve(this.parsePropfindResponse(data, url));
          } else {
            reject(new Error(`PROPFIND ${url}: ${res.statusCode}`));
          }
        });
      });
      req.on('error', reject);

      // PROPFIND body requesting basic properties
      req.write('<?xml version="1.0" encoding="UTF-8"?>' +
        '<d:propfind xmlns:d="DAV:">' +
        '<d:prop><d:getlastmodified/><d:displayname/></d:prop>' +
        '</d:propfind>');
      req.end();
    });
  }

  /** MKCOL to create a remote directory */
  private webdavMkcol(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const reqFn = this.getRequestFn(url);
      const req = reqFn({
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname,
        method: 'MKCOL',
        headers: {
          'Authorization': `Basic ${this.getAuth()}`,
        },
      }, (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk; });
        res.on('end', () => {
          // 201 = created, 405 = already exists — both are fine
          if (res.statusCode === 201 || res.statusCode === 405 || res.statusCode === 301) {
            resolve();
          } else {
            reject(new Error(`MKCOL ${url}: ${res.statusCode}`));
          }
        });
      });
      req.on('error', reject);
      req.end();
    });
  }

  /** Parse PROPFIND XML response to extract file names and dates */
  private parsePropfindResponse(xml: string, baseUrl: string): Array<{ name: string; lastModified: string }> {
    const files: Array<{ name: string; lastModified: string }> = [];

    // Simple XML parsing — extract <d:href> and <d:getlastmodified>
    const responseBlocks = xml.split(/<d:response>/i).slice(1);
    const basePath = new URL(baseUrl).pathname;

    for (const block of responseBlocks) {
      const hrefMatch = block.match(/<d:href>(.*?)<\/d:href>/i);
      const dateMatch = block.match(/<d:getlastmodified>(.*?)<\/d:getlastmodified>/i);

      if (hrefMatch) {
        const href = decodeURIComponent(hrefMatch[1]);
        // Skip the directory itself
        if (href === basePath || href === basePath.replace(/\/$/, '')) continue;

        const name = href.split('/').filter(Boolean).pop() || '';
        if (name) {
          files.push({
            name,
            lastModified: dateMatch?.[1] || '',
          });
        }
      }
    }

    return files;
  }
}
