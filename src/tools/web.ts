import { z } from 'zod';
import type { ToolDef } from './types.js';
import { ok, fail } from './types.js';
import type { Config } from '../config.js';

export function registerWebTools(config: Config): ToolDef[] {
  const tools: ToolDef[] = [
    createWebFetchTool(config.agentlensUrl),
    createHttpRequestTool(),
  ];

  if (config.searxngUrl) {
    tools.push(createWebSearchTool(config.searxngUrl));
  }

  return tools;
}

/** Extract a page via agentlens (`GET /parse?url=`), returning token-efficient
 *  readable content. Returns null on any failure so the caller can fall back to
 *  a raw fetch. agentlens response shape: { title, content, token_estimate, ... }. */
async function agentlensParse(agentlensUrl: string, url: string): Promise<string | null> {
  try {
    const base = agentlensUrl.replace(/\/+$/, '');
    const res = await fetch(`${base}/parse?url=${encodeURIComponent(url)}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) return null;
    const data = await res.json() as { title?: string | null; content?: string | null };
    const content = (data.content || '').trim();
    if (!content) return null;
    const title = (data.title || '').trim();
    return title ? `# ${title}\n\n${content}` : content;
  } catch {
    return null;
  }
}

/** Raw fetch + local HTML strip. Fallback when agentlens is unset/unreachable. */
async function rawFetchText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'veepee-code/0.3 (CLI coding assistant)',
      'Accept': 'text/html,application/xhtml+xml,application/json,text/plain',
    },
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  }

  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return JSON.stringify(await res.json(), null, 2);
  }

  const html = await res.text();
  // Basic HTML stripping — remove tags, decode entities, collapse whitespace
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function createWebFetchTool(agentlensUrl: string | null): ToolDef {
  return {
    name: 'web_fetch',
    description: 'Fetch a web page and extract its readable text content. Uses agentlens for token-efficient extraction when configured (falls back to a raw fetch). Good for reading documentation, articles, or API responses.',
    schema: z.object({
      url: z.string().describe('The URL to fetch'),
      max_length: z.number().optional().describe('Maximum characters to return (default 10000)'),
    }),
    execute: async (params) => {
      try {
        const url = params.url as string;
        const maxLen = (params.max_length as number) || 10000;

        // Prefer agentlens (token-efficient extraction). Fall back to a raw
        // fetch + local HTML strip if it's unset or unreachable.
        let text: string | null = agentlensUrl ? await agentlensParse(agentlensUrl, url) : null;
        if (text === null) {
          text = await rawFetchText(url);
        }

        if (text.length > maxLen) {
          text = text.slice(0, maxLen) + `\n... (truncated at ${maxLen} chars)`;
        }

        return ok(text);
      } catch (err) {
        return fail(`Fetch failed: ${(err as Error).message}`);
      }
    },
  };
}

function createHttpRequestTool(): ToolDef {
  return {
    name: 'http_request',
    description: 'Make an HTTP request with full control over method, headers, and body. Use for API calls.',
    schema: z.object({
      url: z.string().describe('The URL to request'),
      method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']).optional().describe('HTTP method (default GET)'),
      headers: z.string().optional().describe('Headers as JSON string, e.g. {"Authorization": "Bearer xxx"}'),
      body: z.string().optional().describe('Request body (string or JSON string)'),
    }),
    execute: async (params) => {
      try {
        const method = (params.method as string) || 'GET';
        let headers: Record<string, string> = {};

        if (params.headers) {
          try {
            headers = JSON.parse(params.headers as string);
          } catch {
            return fail('Invalid headers JSON');
          }
        }

        const fetchOpts: RequestInit = {
          method,
          headers,
          signal: AbortSignal.timeout(30000),
        };

        if (params.body && method !== 'GET' && method !== 'HEAD') {
          fetchOpts.body = params.body as string;
          if (!headers['Content-Type'] && !headers['content-type']) {
            (fetchOpts.headers as Record<string, string>)['Content-Type'] = 'application/json';
          }
        }

        const res = await fetch(params.url as string, fetchOpts);
        const contentType = res.headers.get('content-type') || '';
        let body: string;

        if (contentType.includes('json')) {
          body = JSON.stringify(await res.json(), null, 2);
        } else {
          body = await res.text();
        }

        const statusLine = `HTTP ${res.status} ${res.statusText}`;
        if (body.length > 10000) {
          body = body.slice(0, 10000) + '\n... (truncated)';
        }

        return ok(`${statusLine}\n\n${body}`);
      } catch (err) {
        return fail(`Request failed: ${(err as Error).message}`);
      }
    },
  };
}

function createWebSearchTool(searxngUrl: string): ToolDef {
  return {
    name: 'web_search',
    description: 'Search the web using SearXNG. Returns search results with titles, URLs, and snippets. Good for finding documentation, Stack Overflow answers, or current information.',
    schema: z.object({
      query: z.string().describe('Search query'),
      max_results: z.number().optional().describe('Maximum results to return (default 5)'),
    }),
    execute: async (params) => {
      try {
        const maxResults = (params.max_results as number) || 5;
        const base = searxngUrl.replace(/\/+$/, '');
        const url = `${base}/search?q=${encodeURIComponent(params.query as string)}&format=json&language=en`;

        const res = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'veepee-code/0.3' } });
        if (!res.ok) return fail(`Search API returned ${res.status}`);

        const data = await res.json() as { results: Array<{ title: string; url: string; content: string }> };
        const results = (data.results || []).slice(0, maxResults);

        if (results.length === 0) return ok('No results found.');

        const output = results
          .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.content || '(no snippet)'}`)
          .join('\n\n');

        return ok(output);
      } catch (err) {
        return fail(`Search failed: ${(err as Error).message}`);
      }
    },
  };
}
