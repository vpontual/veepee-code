/**
 * VEEPEE Code — Guided Setup Wizard
 *
 * Interactive onboarding that runs in the TUI on first launch.
 * Walks users through every configuration step with explanations.
 * Supports back navigation and per-integration reconfiguration.
 */

import { resolve } from 'path';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { execSync, spawn } from 'child_process';
import chalk from 'chalk';
import { theme, box, icons } from './tui/theme.js';
import {
  enterAltScreen, exitAltScreen, showCursor, hideCursor,
  moveTo, clearLine, clearScreen, getSize, writeAt, center, stripAnsi, wordWrap,
} from './tui/screen.js';
import { getLogo } from './tui/logo.js';

// ─── Types ──────────────────────────────────────────────────────────────────

interface EnvVar {
  key: string;
  label: string;
  default: string;
  secret: boolean;
  hint?: string;
}

interface WizardStep {
  id: string;
  name: string;
  description: string;
  tools: string[];
  required: boolean;
  envVars: EnvVar[];
  validate?: (values: Record<string, string>) => Promise<{ ok: boolean; message: string }>;
}

// ─── Step Definitions ───────────────────────────────────────────────────────

const STEPS: WizardStep[] = [
  {
    id: 'proxy',
    name: 'Ollama Proxy',
    description: 'The Ollama API endpoint where your models are running. This can be a local Ollama instance or a remote server. If you use Ollama Fleet Manager, point this to the proxy address.',
    tools: ['All AI model interactions'],
    required: true,
    envVars: [
      { key: 'VEEPEE_CODE_PROXY_URL', label: 'Proxy URL', default: 'http://localhost:11434', secret: false, hint: 'e.g., http://10.0.153.99:11434' },
    ],
    validate: async (values) => {
      const url = values['VEEPEE_CODE_PROXY_URL'];
      try {
        const res = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(5000) });
        if (res.ok) {
          const data = await res.json() as { models: unknown[] };
          return { ok: true, message: `Connected — ${data.models?.length || 0} models available` };
        }
        return { ok: false, message: `HTTP ${res.status} — check the URL` };
      } catch (err) {
        return { ok: false, message: `Cannot connect to ${url} — ${(err as Error).message}` };
      }
    },
  },
  {
    id: 'dashboard',
    name: 'Fleet Manager Dashboard',
    description: 'If you use Ollama Fleet Manager to route requests across multiple GPU servers, enter the dashboard URL here. This enables load-aware model selection and server health monitoring.',
    tools: ['Model load balancing', 'server health'],
    required: false,
    envVars: [
      { key: 'VEEPEE_CODE_DASHBOARD_URL', label: 'Dashboard URL', default: '', secret: false, hint: 'e.g., http://10.0.153.99:3334' },
    ],
  },
  {
    id: 'model-prefs',
    name: 'Model Preferences',
    description: 'Control which models VEEPEE Code considers. Auto-switch lets the AI pick the best model for each task automatically. Size limits filter out models too large (slow) or too small (weak).',
    tools: ['Model routing'],
    required: false,
    envVars: [
      { key: 'VEEPEE_CODE_AUTO_SWITCH', label: 'Auto-switch models (true/false)', default: 'true', secret: false },
      { key: 'VEEPEE_CODE_MAX_MODEL_SIZE', label: 'Max model size (billions)', default: '40', secret: false, hint: 'Skip models larger than this' },
      { key: 'VEEPEE_CODE_MIN_MODEL_SIZE', label: 'Min model size (billions)', default: '6', secret: false, hint: 'Skip models smaller than this' },
    ],
  },
  {
    id: 'api',
    name: 'API Server',
    description: 'VEEPEE Code exposes an OpenAI-compatible API so other tools (Claude Code, OpenCode, Gemini CLI) can use your local models through it. Set the port it listens on.',
    tools: ['External tool integration'],
    required: false,
    envVars: [
      { key: 'VEEPEE_CODE_API_PORT', label: 'API port', default: '8484', secret: false },
    ],
  },
  {
    id: 'searxng',
    name: 'Web Search (SearXNG)',
    description: 'SearXNG is a privacy-respecting metasearch engine you can self-host. When configured, VEEPEE Code can search the web for current information, documentation, and answers.',
    tools: ['web_search'],
    required: false,
    envVars: [
      { key: 'SEARXNG_URL', label: 'SearXNG URL', default: '', secret: false, hint: 'e.g., http://localhost:8888' },
    ],
    validate: async (values) => {
      const url = values['SEARXNG_URL'];
      if (!url) return { ok: true, message: 'Skipped' };
      try {
        const res = await fetch(`${url}/search?q=test&format=json&engines=duckduckgo&results=1`, { signal: AbortSignal.timeout(5000) });
        return res.ok ? { ok: true, message: 'Connected' } : { ok: false, message: `HTTP ${res.status}` };
      } catch {
        return { ok: false, message: `Cannot connect to ${url}` };
      }
    },
  },
  {
    id: 'ha',
    name: 'Home Assistant',
    description: 'Connect to your Home Assistant instance to control smart home devices, check sensor states, and manage automations — all through natural language.',
    tools: ['home_assistant', 'timer'],
    required: false,
    envVars: [
      { key: 'HA_URL', label: 'Home Assistant URL', default: '', secret: false, hint: 'e.g., http://homeassistant.local:8123' },
      { key: 'HA_TOKEN', label: 'Long-lived access token', default: '', secret: true, hint: 'Create at HA → Profile → Long-Lived Access Tokens' },
    ],
    validate: async (values) => {
      const url = values['HA_URL'];
      const token = values['HA_TOKEN'];
      if (!url || !token) return { ok: true, message: 'Skipped' };
      try {
        const res = await fetch(`${url}/api/`, {
          headers: { 'Authorization': `Bearer ${token}` },
          signal: AbortSignal.timeout(5000),
        });
        return res.ok ? { ok: true, message: 'Connected' } : { ok: false, message: `HTTP ${res.status} — check token` };
      } catch {
        return { ok: false, message: `Cannot connect to ${url}` };
      }
    },
  },
  {
    id: 'mastodon',
    name: 'Mastodon',
    description: 'Connect to your Mastodon account to post, reply, boost, search, and read your timeline — all through the AI assistant.',
    tools: ['mastodon'],
    required: false,
    envVars: [
      { key: 'MASTODON_URL', label: 'Instance URL', default: '', secret: false, hint: 'e.g., https://mastodon.social' },
      { key: 'MASTODON_TOKEN', label: 'Access token', default: '', secret: true, hint: 'Create at Mastodon → Preferences → Development → New Application' },
    ],
    validate: async (values) => {
      const url = values['MASTODON_URL'];
      const token = values['MASTODON_TOKEN'];
      if (!url || !token) return { ok: true, message: 'Skipped' };
      try {
        const res = await fetch(`${url}/api/v1/accounts/verify_credentials`, {
          headers: { 'Authorization': `Bearer ${token}` },
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) {
          const data = await res.json() as { acct: string };
          return { ok: true, message: `Authenticated as @${data.acct}` };
        }
        return { ok: false, message: `HTTP ${res.status} — check token` };
      } catch {
        return { ok: false, message: 'Connection failed' };
      }
    },
  },
  {
    id: 'spotify',
    name: 'Spotify',
    description: 'Control Spotify playback — play, pause, skip, search for music, manage playlists. Requires a Spotify Developer app with OAuth tokens.',
    tools: ['spotify'],
    required: false,
    envVars: [
      { key: 'SPOTIFY_CLIENT_ID', label: 'Client ID', default: '', secret: false, hint: 'From developer.spotify.com/dashboard' },
      { key: 'SPOTIFY_CLIENT_SECRET', label: 'Client secret', default: '', secret: true },
      { key: 'SPOTIFY_REFRESH_TOKEN', label: 'Refresh token', default: '', secret: true },
    ],
    validate: async (values) => {
      if (!values['SPOTIFY_CLIENT_ID'] || !values['SPOTIFY_CLIENT_SECRET'] || !values['SPOTIFY_REFRESH_TOKEN']) {
        return { ok: true, message: 'Skipped' };
      }
      try {
        const res = await fetch('https://accounts.spotify.com/api/token', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Authorization': 'Basic ' + Buffer.from(`${values['SPOTIFY_CLIENT_ID']}:${values['SPOTIFY_CLIENT_SECRET']}`).toString('base64'),
          },
          body: `grant_type=refresh_token&refresh_token=${values['SPOTIFY_REFRESH_TOKEN']}`,
          signal: AbortSignal.timeout(5000),
        });
        return res.ok ? { ok: true, message: 'Token refresh OK' } : { ok: false, message: `Auth failed (${res.status})` };
      } catch {
        return { ok: false, message: 'Auth failed' };
      }
    },
  },
  {
    id: 'google',
    name: 'Google Workspace',
    description: 'Access Gmail, Google Calendar, Drive, Docs, and Sheets through the AI. Requires a Google Cloud OAuth2 app with the appropriate scopes.',
    tools: ['email', 'calendar', 'google_drive', 'google_docs', 'google_sheets', 'notes'],
    required: false,
    envVars: [
      { key: 'GOOGLE_CLIENT_ID', label: 'OAuth Client ID', default: '', secret: false, hint: 'From console.cloud.google.com' },
      { key: 'GOOGLE_CLIENT_SECRET', label: 'OAuth Client secret', default: '', secret: true },
      { key: 'GOOGLE_REFRESH_TOKEN', label: 'Refresh token', default: '', secret: true },
    ],
    validate: async (values) => {
      if (!values['GOOGLE_CLIENT_ID'] || !values['GOOGLE_CLIENT_SECRET'] || !values['GOOGLE_REFRESH_TOKEN']) {
        return { ok: true, message: 'Skipped' };
      }
      try {
        const res = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: values['GOOGLE_CLIENT_ID'],
            client_secret: values['GOOGLE_CLIENT_SECRET'],
            refresh_token: values['GOOGLE_REFRESH_TOKEN'],
            grant_type: 'refresh_token',
          }),
          signal: AbortSignal.timeout(5000),
        });
        return res.ok ? { ok: true, message: 'OAuth refresh OK' } : { ok: false, message: `Auth failed (${res.status})` };
      } catch {
        return { ok: false, message: 'Auth failed' };
      }
    },
  },
  {
    id: 'newsfeed',
    name: 'AI Newsfeed',
    description: 'Connect to an AI-optimized newsfeed API for news briefings, topic search, and trend analysis. This is a custom service — set the URL if you have one running.',
    tools: ['news'],
    required: false,
    envVars: [
      { key: 'NEWSFEED_URL', label: 'Newsfeed API URL', default: '', secret: false, hint: 'e.g., http://10.0.153.99:3333' },
    ],
    validate: async (values) => {
      const url = values['NEWSFEED_URL'];
      if (!url) return { ok: true, message: 'Skipped' };
      try {
        const res = await fetch(`${url}/api/ai/briefing`, {
          headers: { 'Accept': 'text/plain' },
          signal: AbortSignal.timeout(5000),
        });
        return res.ok ? { ok: true, message: 'Connected' } : { ok: false, message: `HTTP ${res.status}` };
      } catch {
        return { ok: false, message: `Cannot connect to ${url}` };
      }
    },
  },
];

// ─── Input Helpers ──────────────────────────────────────────────────────────

/** Result from readLine — includes whether user pressed Escape to go back */
interface InputResult {
  value: string;
  action: 'submit' | 'back';
}

/** Read a line of text from stdin in raw mode. Returns value and action (submit or back). */
function readLine(opts: {
  row: number;
  col: number;
  maxWidth: number;
  label: string;
  default?: string;
  secret?: boolean;
  required?: boolean;
  allowBack?: boolean;
}): Promise<InputResult> {
  return new Promise((resolve) => {
    let text = '';
    let cursor = 0;

    const render = () => {
      moveTo(opts.row, opts.col);
      clearLine();

      const label = theme.accent(opts.label + ': ');
      const defaultHint = opts.default ? theme.dim(` [${opts.default}]`) : '';
      const display = opts.secret ? '*'.repeat(text.length) : text;

      process.stdout.write(label + display + defaultHint);

      // Position cursor
      const labelLen = stripAnsi(opts.label + ': ').length;
      moveTo(opts.row, opts.col + labelLen + cursor);
      showCursor();
    };

    render();

    const handler = (data: Buffer) => {
      const key = data.toString();

      // Enter — submit
      if (key === '\r' || key === '\n') {
        const value = text || opts.default || '';
        if (opts.required && !value) {
          // Flash error
          moveTo(opts.row + 1, opts.col);
          process.stdout.write(theme.error(`  ${icons.cross} This field is required`));
          setTimeout(() => {
            moveTo(opts.row + 1, opts.col);
            clearLine();
          }, 1500);
          return;
        }
        hideCursor();
        process.stdin.removeListener('data', handler);
        resolve({ value, action: 'submit' });
        return;
      }

      // Escape — go back (if allowed and on first field)
      if (key === '\x1b' && data.length === 1 && opts.allowBack) {
        hideCursor();
        process.stdin.removeListener('data', handler);
        resolve({ value: '', action: 'back' });
        return;
      }

      // Ctrl+C — abort wizard
      if (key === '\x03') {
        hideCursor();
        process.stdin.removeListener('data', handler);
        exitAltScreen();
        showCursor();
        process.stdin.setRawMode?.(false);
        process.exit(0);
      }

      // Backspace
      if (key === '\x7f' || key === '\b') {
        if (cursor > 0) {
          text = text.slice(0, cursor - 1) + text.slice(cursor);
          cursor--;
          render();
        }
        return;
      }

      // Left arrow
      if (key === '\x1b[D') {
        if (cursor > 0) { cursor--; render(); }
        return;
      }

      // Right arrow
      if (key === '\x1b[C') {
        if (cursor < text.length) { cursor++; render(); }
        return;
      }

      // Home
      if (key === '\x1b[H' || key === '\x01') {
        cursor = 0; render();
        return;
      }

      // End
      if (key === '\x1b[F' || key === '\x05') {
        cursor = text.length; render();
        return;
      }

      // Ignore other escape sequences
      if (key.startsWith('\x1b')) return;

      // Printable character
      if (key.length === 1 && key >= ' ') {
        text = text.slice(0, cursor) + key + text.slice(cursor);
        cursor++;
        render();
      }
    };

    process.stdin.on('data', handler);
  });
}

/** Show a yes/no prompt, returns true for yes */
function confirm(row: number, col: number, label: string, defaultYes = true): Promise<boolean> {
  return new Promise((resolve) => {
    const hint = defaultYes ? '[Y/n]' : '[y/N]';
    moveTo(row, col);
    process.stdout.write(theme.accent(label + ' ') + theme.dim(hint) + ' ');
    showCursor();

    const handler = (data: Buffer) => {
      const key = data.toString().toLowerCase();
      if (key === '\r' || key === '\n') {
        hideCursor();
        process.stdin.removeListener('data', handler);
        resolve(defaultYes);
        return;
      }
      if (key === 'y') {
        hideCursor();
        process.stdin.removeListener('data', handler);
        resolve(true);
        return;
      }
      if (key === 'n') {
        hideCursor();
        process.stdin.removeListener('data', handler);
        resolve(false);
        return;
      }
      if (key === '\x03') {
        hideCursor();
        process.stdin.removeListener('data', handler);
        exitAltScreen();
        showCursor();
        process.stdin.setRawMode?.(false);
        process.exit(0);
      }
    };

    process.stdin.on('data', handler);
  });
}

/** Wait for any key press */
function waitForKey(): Promise<void> {
  return new Promise((resolve) => {
    const handler = (data: Buffer) => {
      const key = data.toString();
      if (key === '\x03') {
        hideCursor();
        process.stdin.removeListener('data', handler);
        exitAltScreen();
        showCursor();
        process.stdin.setRawMode?.(false);
        process.exit(0);
      }
      process.stdin.removeListener('data', handler);
      resolve();
    };
    process.stdin.on('data', handler);
  });
}

// ─── Rendering Helpers ──────────────────────────────────────────────────────

function renderHeader(stepNum: number, totalSteps: number, stepName: string): number {
  const { cols } = getSize();
  clearScreen();
  hideCursor();

  // Brand bar
  const headerText = `  ${icons.llama} VEEPEE Code Setup`;
  const stepText = `Step ${stepNum}/${totalSteps}`;
  moveTo(1, 1);
  process.stdout.write(theme.brandBold(headerText));
  moveTo(1, cols - stepText.length - 1);
  process.stdout.write(theme.accent(stepText));

  // Separator
  moveTo(2, 1);
  process.stdout.write(theme.dim(box.h.repeat(cols)));

  // Step name
  moveTo(4, 3);
  process.stdout.write(theme.textBold(stepName));

  return 6; // next available row
}

function renderDescription(startRow: number, description: string, tools: string[], required: boolean): number {
  const { cols } = getSize();
  const maxWidth = cols - 8;
  let row = startRow;

  // Description
  const lines = wordWrap(description, maxWidth);
  for (const line of lines) {
    moveTo(row, 5);
    process.stdout.write(theme.dim(line));
    row++;
  }
  row++;

  // Tools
  if (tools.length > 0) {
    moveTo(row, 5);
    process.stdout.write(theme.muted('Enables: ') + theme.accent(tools.join(', ')));
    row++;
  }

  // Required badge
  row++;
  moveTo(row, 5);
  if (required) {
    process.stdout.write(theme.error(`${icons.dot} REQUIRED`));
  } else {
    process.stdout.write(theme.dim(`${icons.circle} OPTIONAL — press Enter to skip`));
  }
  row += 2;

  return row;
}

function renderProgressBar(stepNum: number, totalSteps: number): void {
  const { rows, cols } = getSize();
  const barWidth = Math.min(40, cols - 10);
  const filled = Math.round((stepNum / totalSteps) * barWidth);
  const empty = barWidth - filled;

  const bar = theme.accent('━'.repeat(filled)) + theme.dim('─'.repeat(empty));
  moveTo(rows, 3);
  process.stdout.write(bar + theme.dim(` ${stepNum}/${totalSteps}`));
}

function renderFooter(canGoBack: boolean): void {
  const { rows } = getSize();
  moveTo(rows - 1, 3);
  const parts = ['Enter: confirm'];
  if (canGoBack) parts.push('Esc: back');
  parts.push('Ctrl+C: abort');
  process.stdout.write(theme.dim(parts.join('  |  ')));
}

// ─── GitHub Auth ────────────────────────────────────────────────────────────

async function runGitHubAuth(): Promise<void> {
  const { cols } = getSize();
  clearScreen();
  hideCursor();

  // Header
  moveTo(1, 1);
  process.stdout.write(theme.brandBold(`  ${icons.llama} VEEPEE Code Setup`));
  moveTo(1, cols - 'GitHub Authentication'.length - 1);
  process.stdout.write(theme.accent('GitHub Authentication'));
  moveTo(2, 1);
  process.stdout.write(theme.dim(box.h.repeat(cols)));

  moveTo(4, 3);
  process.stdout.write(theme.textBold('GitHub Authentication'));

  moveTo(6, 5);
  process.stdout.write(theme.dim('VEEPEE Code needs GitHub access to pull updates.'));
  moveTo(7, 5);
  process.stdout.write(theme.dim('This step runs `gh auth login` and configures git credentials.'));

  moveTo(9, 5);
  process.stdout.write(theme.muted('Checking GitHub CLI...'));

  // Check if gh is installed
  try {
    execSync('which gh', { stdio: 'ignore' });
  } catch {
    moveTo(9, 5);
    clearLine();
    process.stdout.write(theme.error(`${icons.cross} GitHub CLI (gh) is not installed.`));
    moveTo(11, 5);
    process.stdout.write(theme.dim('Install it first:'));
    moveTo(12, 7);
    process.stdout.write(theme.accent('brew install gh') + theme.dim('          # macOS'));
    moveTo(13, 7);
    process.stdout.write(theme.accent('sudo apt install gh') + theme.dim('      # Debian/Ubuntu'));
    moveTo(14, 7);
    process.stdout.write(theme.accent('sudo dnf install gh') + theme.dim('      # Fedora'));
    moveTo(15, 7);
    process.stdout.write(theme.accent('https://cli.github.com') + theme.dim('   # Other'));
    moveTo(17, 5);
    process.stdout.write(theme.dim('Press any key to skip this step...'));
    await waitForKey();
    return;
  }

  // Check if already authenticated
  try {
    execSync('gh auth status', { stdio: 'ignore' });
    moveTo(9, 5);
    clearLine();
    process.stdout.write(theme.success(`${icons.check} Already authenticated with GitHub`));

    // Ensure git is wired up
    try {
      execSync('gh auth setup-git', { stdio: 'ignore' });
      moveTo(10, 5);
      process.stdout.write(theme.success(`${icons.check} Git credentials configured`));
    } catch {
      // Non-fatal
    }

    moveTo(12, 5);
    process.stdout.write(theme.dim('Press any key to continue...'));
    await waitForKey();
    return;
  } catch {
    // Not authenticated — run gh auth login
  }

  moveTo(9, 5);
  clearLine();
  process.stdout.write(theme.warning(`${icons.warn} Not authenticated — launching GitHub login...`));
  moveTo(11, 5);
  process.stdout.write(theme.dim('Follow the prompts in your terminal.'));
  moveTo(12, 5);
  process.stdout.write(theme.dim('The wizard will resume automatically after login completes.'));

  // Temporarily exit alt screen so gh auth login can interact with the user
  exitAltScreen();
  showCursor();
  process.stdin.setRawMode?.(false);
  process.stdin.pause();

  // Run gh auth login interactively
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn('gh', ['auth', 'login'], {
        stdio: 'inherit',
      });
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`gh auth login exited with code ${code}`));
      });
      child.on('error', reject);
    });
  } catch {
    // User may have cancelled — continue anyway
  }

  // Set up git credentials
  try {
    execSync('gh auth setup-git', { stdio: 'ignore' });
  } catch {
    // Non-fatal
  }

  // Re-enter alt screen
  process.stdin.resume();
  process.stdin.setRawMode?.(true);
  enterAltScreen();
  hideCursor();

  const { cols: cols2 } = getSize();
  moveTo(1, 1);
  process.stdout.write(theme.brandBold(`  ${icons.llama} VEEPEE Code Setup`));
  moveTo(2, 1);
  process.stdout.write(theme.dim(box.h.repeat(cols2)));

  // Check result
  try {
    execSync('gh auth status', { stdio: 'ignore' });
    moveTo(4, 5);
    process.stdout.write(theme.success(`${icons.check} GitHub authentication complete`));
    moveTo(5, 5);
    process.stdout.write(theme.success(`${icons.check} Git credentials configured`));
  } catch {
    moveTo(4, 5);
    process.stdout.write(theme.warning(`${icons.warn} GitHub authentication skipped — you can set it up later`));
  }

  moveTo(7, 5);
  process.stdout.write(theme.dim('Press any key to continue...'));
  await waitForKey();
}

// ─── Config Helpers ─────────────────────────────────────────────────────────

/** Load existing .env values if file exists */
function loadExistingConfig(): Record<string, string> {
  const homeEnv = resolve(process.env.HOME || '~', '.veepee-code', '.env');
  const values: Record<string, string> = {};
  if (existsSync(homeEnv)) {
    const content = readFileSync(homeEnv, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx > 0) {
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim();
        if (val) values[key] = val;
      }
    }
  }
  return values;
}

/** Save config values to ~/.veepee-code/.env */
function saveConfig(values: Record<string, string>): void {
  const configDir = resolve(process.env.HOME || '~', '.veepee-code');
  mkdirSync(configDir, { recursive: true });

  const lines: string[] = [
    '# ─── VEEPEE Code Configuration ──────────────────────────────────────────────',
    '# Generated by the setup wizard. Edit freely.',
    '',
    '# ─── Ollama Connection (required) ─────────────────────────────────────────────',
    `VEEPEE_CODE_PROXY_URL=${values['VEEPEE_CODE_PROXY_URL'] || 'http://localhost:11434'}`,
  ];

  if (values['VEEPEE_CODE_DASHBOARD_URL']) {
    lines.push(`VEEPEE_CODE_DASHBOARD_URL=${values['VEEPEE_CODE_DASHBOARD_URL']}`);
  } else {
    lines.push('# VEEPEE_CODE_DASHBOARD_URL=');
  }

  lines.push('');
  lines.push('# ─── Model Preferences ────────────────────────────────────────────────────');
  lines.push(`VEEPEE_CODE_AUTO_SWITCH=${values['VEEPEE_CODE_AUTO_SWITCH'] || 'true'}`);
  lines.push(`VEEPEE_CODE_MAX_MODEL_SIZE=${values['VEEPEE_CODE_MAX_MODEL_SIZE'] || '40'}`);
  lines.push(`VEEPEE_CODE_MIN_MODEL_SIZE=${values['VEEPEE_CODE_MIN_MODEL_SIZE'] || '6'}`);

  lines.push('');
  lines.push('# ─── API Server ───────────────────────────────────────────────────────────');
  lines.push(`VEEPEE_CODE_API_PORT=${values['VEEPEE_CODE_API_PORT'] || '8484'}`);

  lines.push('');
  lines.push('# ─── Integrations ────────────────────────────────────────────────────────');

  // SearXNG
  lines.push('');
  lines.push('# SearXNG web search');
  if (values['SEARXNG_URL']) {
    lines.push(`SEARXNG_URL=${values['SEARXNG_URL']}`);
  } else {
    lines.push('# SEARXNG_URL=');
  }

  // Home Assistant
  lines.push('');
  lines.push('# Home Assistant');
  if (values['HA_URL']) {
    lines.push(`HA_URL=${values['HA_URL']}`);
    lines.push(`HA_TOKEN=${values['HA_TOKEN'] || ''}`);
  } else {
    lines.push('# HA_URL=');
    lines.push('# HA_TOKEN=');
  }

  // Mastodon
  lines.push('');
  lines.push('# Mastodon');
  if (values['MASTODON_URL']) {
    lines.push(`MASTODON_URL=${values['MASTODON_URL']}`);
    lines.push(`MASTODON_TOKEN=${values['MASTODON_TOKEN'] || ''}`);
  } else {
    lines.push('# MASTODON_URL=');
    lines.push('# MASTODON_TOKEN=');
  }

  // Spotify
  lines.push('');
  lines.push('# Spotify');
  if (values['SPOTIFY_CLIENT_ID']) {
    lines.push(`SPOTIFY_CLIENT_ID=${values['SPOTIFY_CLIENT_ID']}`);
    lines.push(`SPOTIFY_CLIENT_SECRET=${values['SPOTIFY_CLIENT_SECRET'] || ''}`);
    lines.push(`SPOTIFY_REFRESH_TOKEN=${values['SPOTIFY_REFRESH_TOKEN'] || ''}`);
  } else {
    lines.push('# SPOTIFY_CLIENT_ID=');
    lines.push('# SPOTIFY_CLIENT_SECRET=');
    lines.push('# SPOTIFY_REFRESH_TOKEN=');
  }

  // Google
  lines.push('');
  lines.push('# Google Workspace');
  if (values['GOOGLE_CLIENT_ID']) {
    lines.push(`GOOGLE_CLIENT_ID=${values['GOOGLE_CLIENT_ID']}`);
    lines.push(`GOOGLE_CLIENT_SECRET=${values['GOOGLE_CLIENT_SECRET'] || ''}`);
    lines.push(`GOOGLE_REFRESH_TOKEN=${values['GOOGLE_REFRESH_TOKEN'] || ''}`);
  } else {
    lines.push('# GOOGLE_CLIENT_ID=');
    lines.push('# GOOGLE_CLIENT_SECRET=');
    lines.push('# GOOGLE_REFRESH_TOKEN=');
  }

  // Newsfeed
  lines.push('');
  lines.push('# AI Newsfeed');
  if (values['NEWSFEED_URL']) {
    lines.push(`NEWSFEED_URL=${values['NEWSFEED_URL']}`);
  } else {
    lines.push('# NEWSFEED_URL=');
  }

  lines.push('');

  writeFileSync(resolve(configDir, '.env'), lines.join('\n'));
}

// ─── Step Runner ────────────────────────────────────────────────────────────

/** Run a single wizard step. Returns 'next', 'back', or 'retry'. */
async function runStep(
  step: WizardStep,
  stepNum: number,
  totalSteps: number,
  values: Record<string, string>,
  canGoBack: boolean,
): Promise<'next' | 'back'> {
  let row = renderHeader(stepNum, totalSteps, step.name);
  row = renderDescription(row, step.description, step.tools, step.required);
  renderProgressBar(stepNum, totalSteps);
  renderFooter(canGoBack);

  // Collect values for each env var in this step
  const stepValues: Record<string, string> = {};
  for (let j = 0; j < step.envVars.length; j++) {
    const envVar = step.envVars[j];
    const existingVal = values[envVar.key] || '';
    const defaultVal = existingVal || envVar.default;

    // Show hint if available
    if (envVar.hint) {
      moveTo(row, 5);
      process.stdout.write(theme.dim(envVar.hint));
      row++;
    }

    const result = await readLine({
      row,
      col: 5,
      maxWidth: getSize().cols - 10,
      label: envVar.label,
      default: defaultVal,
      secret: envVar.secret,
      required: step.required && step.envVars.length === 1,
      allowBack: canGoBack && j === 0, // Only allow back on first field
    });

    if (result.action === 'back') {
      return 'back';
    }

    stepValues[envVar.key] = result.value;
    row += 2;
  }

  // Store values
  for (const [key, val] of Object.entries(stepValues)) {
    if (val) values[key] = val;
  }

  // Validate if validator exists and values were provided
  const hasAnyValue = Object.values(stepValues).some(v => v !== '');
  if (step.validate && hasAnyValue) {
    moveTo(row, 5);
    process.stdout.write(theme.muted('Testing connection...'));

    const result = await step.validate(stepValues);
    moveTo(row, 5);
    clearLine();

    if (result.ok) {
      process.stdout.write(theme.success(`  ${icons.check} ${result.message}`));
    } else {
      process.stdout.write(theme.error(`  ${icons.cross} ${result.message}`));

      // For required steps, let user retry
      if (step.required) {
        row += 2;
        const retry = await confirm(row, 5, 'Try again?', true);
        if (retry) {
          return runStep(step, stepNum, totalSteps, values, canGoBack);
        }
      }
    }

    await new Promise(r => setTimeout(r, 800));
  } else if (!hasAnyValue) {
    moveTo(row, 5);
    process.stdout.write(theme.dim(`  ${icons.circle} Skipped`));
    await new Promise(r => setTimeout(r, 400));
  }

  return 'next';
}

// ─── Public API ─────────────────────────────────────────────────────────────

/** Check if the wizard should run (no config file exists) */
export function needsWizard(): boolean {
  const homeEnv = resolve(process.env.HOME || '~', '.veepee-code', '.env');
  return !existsSync(homeEnv);
}

/** Run the guided setup wizard for all steps */
export async function runWizard(): Promise<void> {
  const existing = loadExistingConfig();
  const values: Record<string, string> = { ...existing };
  const totalSteps = STEPS.length;

  // Enter alt screen and raw mode
  enterAltScreen();
  hideCursor();
  process.stdin.setRawMode?.(true);
  process.stdin.resume();

  // ─── Welcome Screen ────────────────────────────────────────────────
  {
    const { rows, cols } = getSize();
    clearScreen();

    // Logo
    const logo = getLogo(cols);
    let row = Math.max(2, Math.floor((rows - logo.length - 10) / 3));
    for (const line of logo) {
      moveTo(row, Math.max(1, Math.floor((cols - stripAnsi(line).length) / 2)));
      process.stdout.write(line);
      row++;
    }

    row += 2;
    moveTo(row, 1);
    process.stdout.write(center(theme.textBold("Let's set up VEEPEE Code"), cols));
    row += 2;
    moveTo(row, 1);
    process.stdout.write(center(theme.dim("We'll walk through each configuration step."), cols));
    row++;
    moveTo(row, 1);
    process.stdout.write(center(theme.dim('Optional steps can be skipped by pressing Enter.'), cols));
    row++;
    moveTo(row, 1);
    process.stdout.write(center(theme.dim('Press Esc on any step to go back.'), cols));
    row += 3;
    moveTo(row, 1);
    process.stdout.write(center(theme.accent('Press any key to begin...'), cols));

    await waitForKey();
  }

  // ─── GitHub Auth Step ──────────────────────────────────────────────
  await runGitHubAuth();

  // ─── Walk Through Steps (with back navigation) ────────────────────
  let i = 0;
  while (i < STEPS.length) {
    const step = STEPS[i];
    const canGoBack = i > 0;
    const result = await runStep(step, i + 1, totalSteps, values, canGoBack);

    if (result === 'back' && i > 0) {
      i--;
    } else {
      i++;
    }
  }

  // ─── Summary Screen ───────────────────────────────────────────────
  await renderSummary(values, STEPS);

  // Clean up
  exitAltScreen();
  showCursor();
  process.stdin.setRawMode?.(false);
}

/** Run the wizard for a single integration by name */
export async function runWizardForStep(stepId: string): Promise<void> {
  const step = STEPS.find(s => s.id === stepId || s.name.toLowerCase() === stepId.toLowerCase());
  if (!step) return;

  const existing = loadExistingConfig();
  const values: Record<string, string> = { ...existing };

  // Enter alt screen and raw mode
  enterAltScreen();
  hideCursor();
  process.stdin.setRawMode?.(true);
  process.stdin.resume();

  await runStep(step, 1, 1, values, false);

  // Save immediately
  saveConfig(values);

  clearScreen();
  moveTo(1, 1);
  process.stdout.write(theme.brandBold(`  ${icons.llama} VEEPEE Code Setup`));
  moveTo(2, 1);
  process.stdout.write(theme.dim(box.h.repeat(getSize().cols)));
  moveTo(4, 5);
  process.stdout.write(theme.success(`${icons.check} ${step.name} configuration saved!`));
  moveTo(6, 5);
  process.stdout.write(theme.dim('Press any key to continue...'));
  await waitForKey();

  // Clean up
  exitAltScreen();
  showCursor();
  process.stdin.setRawMode?.(false);
}

/** Get list of available step IDs for tab completion */
export function getWizardStepIds(): string[] {
  return STEPS.map(s => s.id);
}

// ─── Summary Screen ─────────────────────────────────────────────────────────

async function renderSummary(values: Record<string, string>, steps: WizardStep[]): Promise<void> {
  const { cols } = getSize();
  clearScreen();
  hideCursor();

  moveTo(1, 1);
  process.stdout.write(theme.brandBold(`  ${icons.llama} VEEPEE Code Setup`));
  moveTo(1, cols - 'Summary'.length - 1);
  process.stdout.write(theme.accent('Summary'));
  moveTo(2, 1);
  process.stdout.write(theme.dim(box.h.repeat(cols)));

  moveTo(4, 3);
  process.stdout.write(theme.textBold('Configuration Summary'));

  let row = 6;
  let configuredCount = 0;

  for (const step of steps) {
    const hasValues = step.envVars.some(ev => values[ev.key]);
    const icon = hasValues ? theme.success(icons.check) : theme.dim(icons.circle);
    const status = hasValues ? theme.text(step.name) : theme.dim(step.name);
    const badge = step.required ? theme.error(' REQUIRED') : '';

    moveTo(row, 5);
    process.stdout.write(`${icon} ${status}${badge}`);

    if (hasValues) {
      configuredCount++;
      // Show first value as preview
      const firstVar = step.envVars[0];
      const val = values[firstVar.key] || '';
      if (val && !firstVar.secret) {
        moveTo(row, 40);
        process.stdout.write(theme.dim(val.length > 35 ? val.slice(0, 32) + '...' : val));
      } else if (val && firstVar.secret) {
        moveTo(row, 40);
        process.stdout.write(theme.dim('****'));
      }
    }

    row++;
  }

  row += 2;
  moveTo(row, 5);
  process.stdout.write(theme.accent(`${configuredCount}/${steps.length}`) + theme.text(' integrations configured'));

  row += 1;
  moveTo(row, 5);
  const configPath = resolve(process.env.HOME || '~', '.veepee-code', '.env');
  process.stdout.write(theme.dim(`Config: ${configPath}`));

  row += 2;
  const shouldSave = await confirm(row, 5, 'Save and start VEEPEE Code?', true);

  if (shouldSave) {
    saveConfig(values);

    moveTo(row + 2, 5);
    process.stdout.write(theme.success(`${icons.check} Configuration saved!`));
    await new Promise(r => setTimeout(r, 1000));
  } else {
    moveTo(row + 2, 5);
    process.stdout.write(theme.warning(`${icons.warn} Configuration not saved. Run the wizard again with --wizard.`));
    await new Promise(r => setTimeout(r, 1500));
  }
}
