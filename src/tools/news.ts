import { z } from 'zod';
import type { ToolDef } from './types.js';
import { ok, fail } from './types.js';
import type { Config } from '../config.js';

export function registerNewsTools(config: Config): ToolDef[] {
  if (!config.newsfeedUrl) return [];
  return [createNewsTool(config.newsfeedUrl)];
}

function createNewsTool(newsfeedUrl: string): ToolDef {
  return {
    name: 'news',
    description: 'Get news from the AI-optimized newsfeed. Supports briefings, digests, search, trends, topic deep-dives, and story tracking.',
    schema: z.object({
      action: z.enum(['briefing', 'digest', 'search', 'trends', 'topic', 'story']).describe('News action'),
      query: z.string().optional().describe('Search query or topic name'),
      story_id: z.string().optional().describe('Story ID for story action'),
      hours: z.number().optional().describe('Time window in hours (default varies by action)'),
    }),
    execute: async (params) => {
      try {
        const action = params.action as string;
        const baseUrl = `${newsfeedUrl}/api/ai`;

        let url: string;
        switch (action) {
          case 'briefing':
            url = `${baseUrl}/briefing`;
            break;
          case 'digest':
            url = `${baseUrl}/digest?hours=${(params.hours as number) || 24}`;
            break;
          case 'search':
            if (!params.query) return fail('query is required for search');
            url = `${baseUrl}/search?q=${encodeURIComponent(params.query as string)}`;
            break;
          case 'trends':
            url = `${baseUrl}/trends?hours=${(params.hours as number) || 48}`;
            break;
          case 'topic':
            if (!params.query) return fail('topic name is required');
            url = `${baseUrl}/topic/${encodeURIComponent(params.query as string)}`;
            break;
          case 'story':
            if (!params.story_id) return fail('story_id is required');
            url = `${baseUrl}/story/${params.story_id}`;
            break;
          default:
            return fail(`Unknown action: ${action}`);
        }

        const res = await fetch(url, {
          headers: { 'Accept': 'text/plain' },
          signal: AbortSignal.timeout(15000),
        });

        if (!res.ok) return fail(`News API returned ${res.status}`);

        const text = await res.text();
        return ok(text.slice(0, 8000));
      } catch (err) {
        return fail(`News failed: ${(err as Error).message}`);
      }
    },
  };
}
