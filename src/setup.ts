import type { Config } from './config.js';
import { theme, icons } from './tui/index.js';

export interface IntegrationStatus {
  name: string;
  category: string;
  status: 'active' | 'missing_config' | 'error';
  tools: string[];
  message: string;
  requiredEnvVars: string[];
}

/** Validate all tool integrations and report status */
export async function validateIntegrations(config: Config): Promise<IntegrationStatus[]> {
  const results: IntegrationStatus[] = [];

  // ─── Core (always available) ──────────────────────────────────────
  results.push({
    name: 'Filesystem',
    category: 'Coding',
    status: 'active',
    tools: ['read_file', 'write_file', 'edit_file', 'list_files', 'glob', 'grep'],
    message: 'Always available',
    requiredEnvVars: [],
  });

  results.push({
    name: 'Shell & Git',
    category: 'Coding',
    status: 'active',
    tools: ['bash', 'git'],
    message: 'Always available',
    requiredEnvVars: [],
  });

  results.push({
    name: 'Docker',
    category: 'DevOps',
    status: 'active',
    tools: ['docker'],
    message: 'Always available (requires Docker installed)',
    requiredEnvVars: [],
  });

  results.push({
    name: 'System Info',
    category: 'DevOps',
    status: 'active',
    tools: ['system_info'],
    message: 'Always available',
    requiredEnvVars: [],
  });

  results.push({
    name: 'Weather',
    category: 'Home',
    status: 'active',
    tools: ['weather'],
    message: 'Open-Meteo (free, no key needed)',
    requiredEnvVars: [],
  });

  results.push({
    name: 'Web Fetch & HTTP',
    category: 'Web',
    status: 'active',
    tools: ['web_fetch', 'http_request'],
    message: 'Always available',
    requiredEnvVars: [],
  });

  // ─── Proxy connection ─────────────────────────────────────────────
  try {
    const res = await fetch(`${config.proxyUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const data = await res.json() as { models: unknown[] };
      results.push({
        name: 'Ollama Proxy',
        category: 'Core',
        status: 'active',
        tools: [],
        message: `Connected — ${data.models?.length || 0} models available`,
        requiredEnvVars: ['LLAMA_CODE_PROXY_URL'],
      });
    } else {
      results.push({
        name: 'Ollama Proxy',
        category: 'Core',
        status: 'error',
        tools: [],
        message: `HTTP ${res.status} — check proxy URL`,
        requiredEnvVars: ['LLAMA_CODE_PROXY_URL'],
      });
    }
  } catch {
    results.push({
      name: 'Ollama Proxy',
      category: 'Core',
      status: 'error',
      tools: [],
      message: `Cannot connect to ${config.proxyUrl}`,
      requiredEnvVars: ['LLAMA_CODE_PROXY_URL'],
    });
  }

  // ─── Web Search (SearXNG) ─────────────────────────────────────────
  if (config.searxngUrl) {
    try {
      const res = await fetch(`${config.searxngUrl}/search?q=test&format=json&engines=duckduckgo&results=1`, { signal: AbortSignal.timeout(5000) });
      results.push({
        name: 'Web Search (SearXNG)',
        category: 'Web',
        status: res.ok ? 'active' : 'error',
        tools: ['web_search'],
        message: res.ok ? 'Connected' : `HTTP ${res.status}`,
        requiredEnvVars: ['SEARXNG_URL'],
      });
    } catch {
      results.push({
        name: 'Web Search (SearXNG)',
        category: 'Web',
        status: 'error',
        tools: ['web_search'],
        message: `Cannot connect to ${config.searxngUrl}`,
        requiredEnvVars: ['SEARXNG_URL'],
      });
    }
  } else {
    results.push({
      name: 'Web Search (SearXNG)',
      category: 'Web',
      status: 'missing_config',
      tools: ['web_search'],
      message: 'Set SEARXNG_URL in .env',
      requiredEnvVars: ['SEARXNG_URL'],
    });
  }

  // ─── Home Assistant ───────────────────────────────────────────────
  if (config.ha) {
    try {
      const res = await fetch(`${config.ha.url}/api/`, {
        headers: { 'Authorization': `Bearer ${config.ha.token}` },
        signal: AbortSignal.timeout(5000),
      });
      results.push({
        name: 'Home Assistant',
        category: 'Home',
        status: res.ok ? 'active' : 'error',
        tools: ['home_assistant', 'timer'],
        message: res.ok ? 'Connected' : `HTTP ${res.status} — check token`,
        requiredEnvVars: ['HA_URL', 'HA_TOKEN'],
      });
    } catch {
      results.push({
        name: 'Home Assistant',
        category: 'Home',
        status: 'error',
        tools: ['home_assistant', 'timer'],
        message: `Cannot connect to ${config.ha.url}`,
        requiredEnvVars: ['HA_URL', 'HA_TOKEN'],
      });
    }
  } else {
    results.push({
      name: 'Home Assistant',
      category: 'Home',
      status: 'missing_config',
      tools: ['home_assistant', 'timer'],
      message: 'Set HA_URL and HA_TOKEN in .env',
      requiredEnvVars: ['HA_URL', 'HA_TOKEN'],
    });
  }

  // ─── Mastodon ─────────────────────────────────────────────────────
  if (config.mastodon) {
    try {
      const res = await fetch(`${config.mastodon.url}/api/v1/accounts/verify_credentials`, {
        headers: { 'Authorization': `Bearer ${config.mastodon.token}` },
        signal: AbortSignal.timeout(5000),
      });
      const data = res.ok ? await res.json() as { acct: string } : null;
      results.push({
        name: 'Mastodon',
        category: 'Social',
        status: res.ok ? 'active' : 'error',
        tools: ['mastodon'],
        message: res.ok ? `@${data?.acct}` : `HTTP ${res.status} — check token`,
        requiredEnvVars: ['MASTODON_URL', 'MASTODON_TOKEN'],
      });
    } catch {
      results.push({
        name: 'Mastodon',
        category: 'Social',
        status: 'error',
        tools: ['mastodon'],
        message: 'Connection failed',
        requiredEnvVars: ['MASTODON_URL', 'MASTODON_TOKEN'],
      });
    }
  } else {
    results.push({
      name: 'Mastodon',
      category: 'Social',
      status: 'missing_config',
      tools: ['mastodon'],
      message: 'Set MASTODON_URL and MASTODON_TOKEN in .env',
      requiredEnvVars: ['MASTODON_URL', 'MASTODON_TOKEN'],
    });
  }

  // ─── Spotify ──────────────────────────────────────────────────────
  if (config.spotify) {
    try {
      const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': 'Basic ' + Buffer.from(`${config.spotify.clientId}:${config.spotify.clientSecret}`).toString('base64'),
        },
        body: `grant_type=refresh_token&refresh_token=${config.spotify.refreshToken}`,
        signal: AbortSignal.timeout(5000),
      });
      results.push({
        name: 'Spotify',
        category: 'Social',
        status: tokenRes.ok ? 'active' : 'error',
        tools: ['spotify'],
        message: tokenRes.ok ? 'Token refresh OK' : `Auth failed (${tokenRes.status})`,
        requiredEnvVars: ['SPOTIFY_CLIENT_ID', 'SPOTIFY_CLIENT_SECRET', 'SPOTIFY_REFRESH_TOKEN'],
      });
    } catch {
      results.push({
        name: 'Spotify',
        category: 'Social',
        status: 'error',
        tools: ['spotify'],
        message: 'Auth failed',
        requiredEnvVars: ['SPOTIFY_CLIENT_ID', 'SPOTIFY_CLIENT_SECRET', 'SPOTIFY_REFRESH_TOKEN'],
      });
    }
  } else {
    results.push({
      name: 'Spotify',
      category: 'Social',
      status: 'missing_config',
      tools: ['spotify'],
      message: 'Set SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, SPOTIFY_REFRESH_TOKEN in .env',
      requiredEnvVars: ['SPOTIFY_CLIENT_ID', 'SPOTIFY_CLIENT_SECRET', 'SPOTIFY_REFRESH_TOKEN'],
    });
  }

  // ─── Google Workspace ─────────────────────────────────────────────
  if (config.google) {
    try {
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: config.google.clientId,
          client_secret: config.google.clientSecret,
          refresh_token: config.google.refreshToken,
          grant_type: 'refresh_token',
        }),
        signal: AbortSignal.timeout(5000),
      });
      results.push({
        name: 'Google Workspace',
        category: 'Google',
        status: tokenRes.ok ? 'active' : 'error',
        tools: ['email', 'calendar', 'google_drive', 'google_docs', 'google_sheets', 'notes'],
        message: tokenRes.ok ? 'OAuth refresh OK' : `Auth failed (${tokenRes.status})`,
        requiredEnvVars: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN'],
      });
    } catch {
      results.push({
        name: 'Google Workspace',
        category: 'Google',
        status: 'error',
        tools: ['email', 'calendar', 'google_drive', 'google_docs', 'google_sheets', 'notes'],
        message: 'Auth failed',
        requiredEnvVars: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN'],
      });
    }
  } else {
    results.push({
      name: 'Google Workspace',
      category: 'Google',
      status: 'missing_config',
      tools: ['email', 'calendar', 'google_drive', 'google_docs', 'google_sheets', 'notes'],
      message: 'Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN in .env',
      requiredEnvVars: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN'],
    });
  }

  // ─── News ─────────────────────────────────────────────────────────
  if (config.newsfeedUrl) {
    try {
      const res = await fetch(`${config.newsfeedUrl}/api/ai/briefing`, {
        headers: { 'Accept': 'text/plain' },
        signal: AbortSignal.timeout(5000),
      });
      results.push({
        name: 'Newsfeed',
        category: 'News',
        status: res.ok ? 'active' : 'error',
        tools: ['news'],
        message: res.ok ? 'AI API connected' : `HTTP ${res.status}`,
        requiredEnvVars: ['NEWSFEED_URL'],
      });
    } catch {
      results.push({
        name: 'Newsfeed',
        category: 'News',
        status: 'error',
        tools: ['news'],
        message: `Cannot connect to ${config.newsfeedUrl}`,
        requiredEnvVars: ['NEWSFEED_URL'],
      });
    }
  } else {
    results.push({
      name: 'Newsfeed',
      category: 'News',
      status: 'missing_config',
      tools: ['news'],
      message: 'Set NEWSFEED_URL in .env',
      requiredEnvVars: ['NEWSFEED_URL'],
    });
  }

  return results;
}

/** Format integration status for TUI display */
export function formatSetupReport(results: IntegrationStatus[]): string {
  const lines: string[] = ['', theme.textBold('  Integration Status'), ''];

  const active = results.filter(r => r.status === 'active');
  const missing = results.filter(r => r.status === 'missing_config');
  const errors = results.filter(r => r.status === 'error');

  // Active integrations
  if (active.length > 0) {
    lines.push(theme.success(`  ${icons.check} Active (${active.length}):`));
    for (const r of active) {
      const tools = r.tools.length > 0 ? theme.dim(` [${r.tools.join(', ')}]`) : '';
      lines.push(`    ${theme.success(icons.dot)} ${r.name}${tools} — ${theme.dim(r.message)}`);
    }
    lines.push('');
  }

  // Missing config
  if (missing.length > 0) {
    lines.push(theme.warning(`  ${icons.circle} Needs Configuration (${missing.length}):`));
    for (const r of missing) {
      const tools = r.tools.length > 0 ? theme.dim(` [${r.tools.join(', ')}]`) : '';
      lines.push(`    ${theme.warning(icons.circle)} ${r.name}${tools}`);
      lines.push(`      ${theme.dim(r.message)}`);
    }
    lines.push('');
  }

  // Errors
  if (errors.length > 0) {
    lines.push(theme.error(`  ${icons.cross} Errors (${errors.length}):`));
    for (const r of errors) {
      const tools = r.tools.length > 0 ? theme.dim(` [${r.tools.join(', ')}]`) : '';
      lines.push(`    ${theme.error(icons.cross)} ${r.name}${tools} — ${theme.error(r.message)}`);
    }
    lines.push('');
  }

  // Summary
  const totalTools = results.reduce((sum, r) => sum + r.tools.length, 0);
  const activeTools = active.reduce((sum, r) => sum + r.tools.length, 0);
  lines.push(theme.dim(`  ${activeTools}/${totalTools} tools active  |  Config: ~/.llama-code/.env or ./.env`));
  lines.push('');

  return lines.join('\n');
}
