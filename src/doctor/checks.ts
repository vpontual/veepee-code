/**
 * Built-in doctor checks. Each check is a small focused function that
 * answers one question. Many have an optional fix() — if so, /doctor
 * offers it after user confirmation.
 *
 * Add new checks here when shipping a feature whose health is worth
 * surfacing. The lint rule of thumb: would the user benefit from
 * knowing this is broken before they hit it during a session?
 */

import type { Check, CheckResult, FixOutcome } from './types.js';
import type { Config } from '../config.js';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { URL } from 'node:url';

/** Quick liveness probe via /api/version. Returns null on failure. */
async function probeOllama(url: string, timeoutMs = 3000): Promise<{ version?: string; latencyMs: number } | null> {
  return new Promise((resolve) => {
    const u = new URL(url);
    const start = Date.now();
    const req = httpRequest({
      method: 'GET',
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: '/api/version',
      timeout: timeoutMs,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        try {
          const j = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as { version?: string };
          resolve({ version: j.version, latencyMs: Date.now() - start });
        } catch {
          resolve({ latencyMs: Date.now() - start });
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

/** Best-effort PATH lookup. Returns the full path or null. */
function whichBin(name: string): string | null {
  try {
    const r = spawnSync('which', [name], { encoding: 'utf-8' });
    if (r.status === 0) return r.stdout.trim();
  } catch { /* ignore */ }
  return null;
}

/** ─── Proxy / fleet ──────────────────────────────────────────────────── */

function checkProxyReachable(config: Config): Check {
  return {
    id: 'proxy-reachable',
    category: 'Network',
    description: `Ollama proxy at ${config.proxyUrl}`,
    async run(): Promise<CheckResult> {
      const r = await probeOllama(config.proxyUrl);
      if (!r) {
        return { severity: 'error', message: `Proxy unreachable at ${config.proxyUrl}`, detail: 'No model calls will work. Check the proxy is running and the URL is correct.' };
      }
      return { severity: 'ok', message: `Proxy reachable (${r.latencyMs}ms${r.version ? `, ollama ${r.version}` : ''})` };
    },
  };
}

function checkFleetServer(server: { name: string; url: string }): Check {
  return {
    id: `fleet-${server.name}`,
    category: 'Network',
    description: `Fleet server "${server.name}" at ${server.url}`,
    async run(): Promise<CheckResult> {
      const r = await probeOllama(server.url);
      if (!r) {
        return { severity: 'warn', message: `${server.name} unreachable at ${server.url}`, detail: 'Subagents pinned to this server will fail. Other models still work via the proxy.' };
      }
      return { severity: 'ok', message: `${server.name} reachable (${r.latencyMs}ms${r.version ? `, ollama ${r.version}` : ''})` };
    },
  };
}

/** ─── CLI tools ──────────────────────────────────────────────────────── */

function checkCliTool(name: string, severity: 'warn' | 'error' | 'info', purpose: string): Check {
  return {
    id: `cli-${name}`,
    category: 'CLI tools',
    description: `${name} on PATH`,
    async run(): Promise<CheckResult> {
      const path = whichBin(name);
      if (!path) {
        return { severity, message: `${name} not on PATH`, detail: purpose };
      }
      // Try --version for context but don't fail on missing
      try {
        const v = execFileSync(name, ['--version'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).split('\n')[0].trim();
        return { severity: 'ok', message: `${name} found (${v})` };
      } catch {
        return { severity: 'ok', message: `${name} found at ${path}` };
      }
    },
  };
}

/** ─── LSP servers ────────────────────────────────────────────────────── */

function checkLspBinary(label: string, command: string): Check {
  const check: Check = {
    id: `lsp-bin-${label}`,
    category: 'LSP',
    description: `${label} server binary (${command})`,
    async run(): Promise<CheckResult> {
      // Absolute paths are checked directly; PATH names use which.
      if (command.startsWith('/') || command.startsWith('./')) {
        if (existsSync(command)) {
          return { severity: 'ok', message: `${label} server present at ${command}` };
        }
        return { severity: 'error', message: `${label} server missing at ${command}` };
      }
      const path = whichBin(command);
      if (!path) {
        return { severity: 'error', message: `${label} server '${command}' not on PATH`, detail: `lsp_diagnostics will fail for this language. Run /lsp install ${label} or /doctor fix to install it.` };
      }
      return { severity: 'ok', message: `${label} server found at ${path}` };
    },
    fix: async (): Promise<FixOutcome> => {
      const { recipeByLabel, runInstall } = await import('../lsp/install.js');
      const recipe = recipeByLabel(label);
      if (!recipe) {
        return { ok: false, message: `No install recipe for label '${label}'. Install ${command} manually.` };
      }
      const out = runInstall(recipe);
      return { ok: out.ok, message: out.message };
    },
    fixLabel: `Install ${label} server`,
  };
  return check;
}

/** ─── Roster ─────────────────────────────────────────────────────────── */

function checkRosterFreshness(): Check {
  return {
    id: 'roster-fresh',
    category: 'Models',
    description: 'Latest benchmark results',
    async run(): Promise<CheckResult> {
      const path = resolve(process.env.HOME || '~', '.veepee-code', 'benchmarks', 'latest.json');
      if (!existsSync(path)) {
        return { severity: 'warn', message: 'No benchmark results yet', detail: 'Run /benchmark to populate the roster. Without it, model selection falls back to the configured default only.' };
      }
      const stat = statSync(path);
      const ageDays = (Date.now() - stat.mtimeMs) / (1000 * 60 * 60 * 24);
      if (ageDays > 30) {
        return { severity: 'warn', message: `Roster is ${ageDays.toFixed(0)} days old`, detail: 'Models on the fleet may have been updated. Run /benchmark to refresh.' };
      }
      if (ageDays > 7) {
        return { severity: 'info', message: `Roster is ${ageDays.toFixed(0)} days old (still usable)` };
      }
      return { severity: 'ok', message: `Roster is ${ageDays.toFixed(0)} day${ageDays < 1 ? '' : 's'} old` };
    },
  };
}

/** ─── API token ──────────────────────────────────────────────────────── */

function checkApiToken(config: Config): Check {
  return {
    id: 'api-token',
    category: 'API',
    description: 'API token for the RC HTTP server',
    async run(): Promise<CheckResult> {
      if (!config.rc?.enabled) {
        return { severity: 'info', message: 'RC API is disabled' };
      }
      if (!config.apiToken || config.apiToken.length < 8) {
        return { severity: 'error', message: 'apiToken is missing or too short', detail: 'The RC HTTP server will reject all requests. Set apiToken in settings.json to a random 16+ char string.' };
      }
      return { severity: 'ok', message: 'apiToken is set' };
    },
  };
}

/** ─── Settings file integrity ────────────────────────────────────────── */

function checkSettingsReadable(): Check {
  return {
    id: 'settings-readable',
    category: 'Config',
    description: '~/.veepee-code/settings.json',
    async run(): Promise<CheckResult> {
      const path = resolve(process.env.HOME || '~', '.veepee-code', 'settings.json');
      if (!existsSync(path)) {
        return { severity: 'warn', message: 'No global settings.json yet', detail: 'Defaults will be used. Run /setup wizard to create one.' };
      }
      try {
        const fs = await import('node:fs/promises');
        const data = await fs.readFile(path, 'utf-8');
        JSON.parse(data);
        return { severity: 'ok', message: `${path} is valid JSON` };
      } catch (err) {
        return { severity: 'error', message: 'settings.json is not valid JSON', detail: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

/** ─── Hooks executable ───────────────────────────────────────────────── */

function checkHooksExecutable(config: Config): Check {
  return {
    id: 'hooks-executable',
    category: 'Hooks',
    description: 'Configured hook commands resolve',
    async run(): Promise<CheckResult> {
      if (!config.hooks) return { severity: 'info', message: 'No hooks configured' };
      const events = Object.keys(config.hooks);
      const missingBins: string[] = [];
      let total = 0;
      for (const ev of events) {
        const entries = (config.hooks as Record<string, Array<{ command: string }>>)[ev] ?? [];
        for (const entry of entries) {
          total++;
          const firstWord = entry.command.split(/\s+/)[0];
          // Skip shell built-ins and absolute paths we can't easily check.
          if (firstWord.startsWith('/') || firstWord.startsWith('./')) continue;
          if (['echo', 'cd', 'true', 'false', ':', 'exit', 'export'].includes(firstWord)) continue;
          if (!whichBin(firstWord)) {
            if (!missingBins.includes(firstWord)) missingBins.push(firstWord);
          }
        }
      }
      if (missingBins.length > 0) {
        return { severity: 'warn', message: `${missingBins.length} hook command(s) reference missing binaries`, detail: `Missing: ${missingBins.join(', ')}` };
      }
      return { severity: 'ok', message: `${total} hook${total === 1 ? '' : 's'} configured, all resolvable` };
    },
  };
}

/** ─── MCP servers ────────────────────────────────────────────────────── */

function checkMcpStdioBinaries(config: Config): Check {
  return {
    id: 'mcp-stdio-bins',
    category: 'MCP',
    description: 'MCP stdio server commands resolve',
    async run(): Promise<CheckResult> {
      if (!config.mcpServers) return { severity: 'info', message: 'No MCP servers configured' };
      const missing: string[] = [];
      let total = 0;
      for (const [name, cfg] of Object.entries(config.mcpServers)) {
        if (cfg.disabled) continue;
        if ('command' in cfg) {
          total++;
          const cmd = cfg.command;
          if (cmd.startsWith('/') || cmd.startsWith('./')) {
            if (!existsSync(cmd)) missing.push(`${name} → ${cmd}`);
          } else if (!whichBin(cmd)) {
            missing.push(`${name} → ${cmd}`);
          }
        }
      }
      if (missing.length > 0) {
        return { severity: 'error', message: `${missing.length} MCP server binar${missing.length === 1 ? 'y' : 'ies'} missing`, detail: missing.join('; ') };
      }
      return { severity: 'ok', message: `${total} stdio MCP server${total === 1 ? '' : 's'} configured, all resolvable` };
    },
  };
}

/** ─── Composer ────────────────────────────────────────────────────── */

/** Build the list of checks for the current Config. Pure function — does
 *  not run anything. */
export function defaultChecks(config: Config): Check[] {
  const checks: Check[] = [
    checkSettingsReadable(),
    checkProxyReachable(config),
    ...config.fleet.map((s) => checkFleetServer(s)),
    checkRosterFreshness(),
    checkApiToken(config),
    checkCliTool('git', 'warn', 'git is required by the git/github tools.'),
    checkCliTool('rg', 'warn', 'ripgrep is preferred for grep; falls back to grep when missing.'),
    checkCliTool('gh', 'info', 'gh enables the github tool. Optional but recommended.'),
    checkHooksExecutable(config),
    checkMcpStdioBinaries(config),
  ];

  // LSP binary checks per configured server
  if (config.lsp) {
    for (const [label, cfg] of Object.entries(config.lsp)) {
      if (cfg.enabled === false) continue;
      checks.push(checkLspBinary(label, cfg.command));
    }
  }

  return checks;
}

/** Convenience: does any registered LSP server's binary need installing?
 *  Used by /lsp install --auto and /doctor's fix-suggestion logic. */
export function lspBinariesMissing(config: Config): string[] {
  const missing: string[] = [];
  if (!config.lsp) return missing;
  for (const [label, cfg] of Object.entries(config.lsp)) {
    if (cfg.enabled === false) continue;
    const cmd = cfg.command;
    if (cmd.startsWith('/') || cmd.startsWith('./')) {
      if (!existsSync(cmd)) missing.push(label);
    } else if (!whichBin(cmd)) {
      missing.push(label);
    }
  }
  return missing;
}

/** Stub fix() result for tests where we don't actually want to run the fix. */
export const noopFix = async (): Promise<FixOutcome> => ({ ok: false, message: 'no fix available' });
