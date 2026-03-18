import { z } from 'zod';
import type { ToolDef } from './types.js';
import { ok, fail } from './types.js';
import type { Config } from '../config.js';

export function registerSocialTools(config: Config): ToolDef[] {
  const tools: ToolDef[] = [];

  if (config.mastodon) {
    tools.push(createMastodonTool(config.mastodon.url, config.mastodon.token));
  }

  if (config.spotify) {
    tools.push(createSpotifyTool(config.spotify));
  }

  return tools;
}

function createMastodonTool(mastoUrl: string, token: string): ToolDef {
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  return {
    name: 'mastodon',
    description: 'Interact with Mastodon: read timeline, post, reply, boost, favorite, search, and check notifications.',
    schema: z.object({
      action: z.enum(['timeline', 'notifications', 'post', 'reply', 'boost', 'favorite', 'search']).describe('Action to perform'),
      content: z.string().optional().describe('Post content (for post/reply)'),
      status_id: z.string().optional().describe('Status ID (for reply/boost/favorite)'),
      query: z.string().optional().describe('Search query'),
      limit: z.number().optional().describe('Number of results (default 10)'),
    }),
    execute: async (params) => {
      try {
        const action = params.action as string;
        const limit = (params.limit as number) || 10;

        switch (action) {
          case 'timeline': {
            const res = await fetch(`${mastoUrl}/api/v1/timelines/home?limit=${limit}`, { headers, signal: AbortSignal.timeout(10000) });
            const posts = await res.json() as Array<{ id: string; account: { display_name: string; acct: string }; content: string; created_at: string }>;
            const output = posts.map(p => {
              const text = p.content.replace(/<[^>]+>/g, '').trim();
              return `@${p.account.acct} (${p.created_at.slice(0, 16)}):\n  ${text.slice(0, 200)}`;
            }).join('\n\n');
            return ok(output || 'Timeline is empty');
          }

          case 'notifications': {
            const res = await fetch(`${mastoUrl}/api/v1/notifications?limit=${limit}`, { headers, signal: AbortSignal.timeout(10000) });
            const notifs = await res.json() as Array<{ type: string; account: { acct: string }; status?: { content: string }; created_at: string }>;
            const output = notifs.map(n => {
              const text = n.status?.content?.replace(/<[^>]+>/g, '').slice(0, 100) || '';
              return `${n.type} from @${n.account.acct}: ${text}`;
            }).join('\n');
            return ok(output || 'No notifications');
          }

          case 'post': {
            const content = params.content as string;
            if (!content) return fail('content is required for posting');
            const res = await fetch(`${mastoUrl}/api/v1/statuses`, {
              method: 'POST', headers,
              body: JSON.stringify({ status: content }),
              signal: AbortSignal.timeout(10000),
            });
            const post = await res.json() as { id: string; url: string };
            return ok(`Posted: ${post.url}`);
          }

          case 'reply': {
            const content = params.content as string;
            const statusId = params.status_id as string;
            if (!content || !statusId) return fail('content and status_id are required');
            const res = await fetch(`${mastoUrl}/api/v1/statuses`, {
              method: 'POST', headers,
              body: JSON.stringify({ status: content, in_reply_to_id: statusId }),
              signal: AbortSignal.timeout(10000),
            });
            const post = await res.json() as { id: string; url: string };
            return ok(`Replied: ${post.url}`);
          }

          case 'boost': {
            const statusId = params.status_id as string;
            if (!statusId) return fail('status_id is required');
            await fetch(`${mastoUrl}/api/v1/statuses/${statusId}/reblog`, {
              method: 'POST', headers, signal: AbortSignal.timeout(10000),
            });
            return ok(`Boosted status ${statusId}`);
          }

          case 'favorite': {
            const statusId = params.status_id as string;
            if (!statusId) return fail('status_id is required');
            await fetch(`${mastoUrl}/api/v1/statuses/${statusId}/favourite`, {
              method: 'POST', headers, signal: AbortSignal.timeout(10000),
            });
            return ok(`Favorited status ${statusId}`);
          }

          case 'search': {
            const query = params.query as string;
            if (!query) return fail('query is required for search');
            const res = await fetch(`${mastoUrl}/api/v2/search?q=${encodeURIComponent(query)}&limit=${limit}`, {
              headers, signal: AbortSignal.timeout(10000),
            });
            const data = await res.json() as { statuses: Array<{ id: string; account: { acct: string }; content: string }> };
            const output = data.statuses.map(s => {
              const text = s.content.replace(/<[^>]+>/g, '').slice(0, 200);
              return `@${s.account.acct}: ${text}`;
            }).join('\n\n');
            return ok(output || 'No results');
          }
        }

        return fail(`Unknown action: ${action}`);
      } catch (err) {
        return fail(`Mastodon failed: ${(err as Error).message}`);
      }
    },
  };
}

function createSpotifyTool(spotify: { clientId: string; clientSecret: string; refreshToken: string }): ToolDef {
  let accessToken: string | null = null;
  let tokenExpiry = 0;

  async function getToken(): Promise<string> {
    if (accessToken && Date.now() < tokenExpiry) return accessToken;

    const res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + Buffer.from(`${spotify.clientId}:${spotify.clientSecret}`).toString('base64'),
      },
      body: `grant_type=refresh_token&refresh_token=${spotify.refreshToken}`,
    });

    const data = await res.json() as { access_token: string; expires_in: number };
    accessToken = data.access_token;
    tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
    return accessToken;
  }

  async function spotifyApi(endpoint: string, method = 'GET', body?: string): Promise<unknown> {
    const token = await getToken();
    const res = await fetch(`https://api.spotify.com/v1${endpoint}`, {
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body,
      signal: AbortSignal.timeout(10000),
    });
    if (res.status === 204) return {};
    return res.json();
  }

  return {
    name: 'spotify',
    description: 'Control Spotify playback: play, pause, skip, volume, search, queue, and see what is currently playing.',
    schema: z.object({
      action: z.enum(['playing', 'play', 'pause', 'next', 'previous', 'volume', 'search', 'queue', 'recent']).describe('Spotify action'),
      query: z.string().optional().describe('Search query (for search action)'),
      uri: z.string().optional().describe('Spotify URI (for play/queue)'),
      volume: z.number().optional().describe('Volume 0-100 (for volume action)'),
    }),
    execute: async (params) => {
      try {
        const action = params.action as string;

        switch (action) {
          case 'playing': {
            const data = await spotifyApi('/me/player/currently-playing') as {
              item?: { name: string; artists: Array<{ name: string }>; album: { name: string } };
              is_playing?: boolean;
              progress_ms?: number;
              item_duration_ms?: number;
            };
            if (!data?.item) return ok('Nothing is currently playing');
            const artists = data.item.artists.map(a => a.name).join(', ');
            return ok(`${data.is_playing ? '▶' : '⏸'} ${data.item.name} — ${artists} (${data.item.album.name})`);
          }

          case 'play':
            if (params.uri) {
              await spotifyApi('/me/player/play', 'PUT', JSON.stringify({ uris: [params.uri] }));
            } else {
              await spotifyApi('/me/player/play', 'PUT');
            }
            return ok('Playing');

          case 'pause':
            await spotifyApi('/me/player/pause', 'PUT');
            return ok('Paused');

          case 'next':
            await spotifyApi('/me/player/next', 'POST');
            return ok('Skipped to next');

          case 'previous':
            await spotifyApi('/me/player/previous', 'POST');
            return ok('Skipped to previous');

          case 'volume': {
            const vol = params.volume as number;
            if (vol === undefined) return fail('volume (0-100) is required');
            await spotifyApi(`/me/player/volume?volume_percent=${vol}`, 'PUT');
            return ok(`Volume set to ${vol}%`);
          }

          case 'search': {
            const query = params.query as string;
            if (!query) return fail('query is required');
            const data = await spotifyApi(`/search?q=${encodeURIComponent(query)}&type=track&limit=5`) as {
              tracks: { items: Array<{ name: string; artists: Array<{ name: string }>; uri: string }> };
            };
            const results = data.tracks.items.map((t, i) => {
              const artists = t.artists.map(a => a.name).join(', ');
              return `${i + 1}. ${t.name} — ${artists} (${t.uri})`;
            }).join('\n');
            return ok(results || 'No results');
          }

          case 'queue': {
            const uri = params.uri as string;
            if (!uri) return fail('uri is required');
            await spotifyApi(`/me/player/queue?uri=${encodeURIComponent(uri)}`, 'POST');
            return ok('Added to queue');
          }

          case 'recent': {
            const data = await spotifyApi('/me/player/recently-played?limit=10') as {
              items: Array<{ track: { name: string; artists: Array<{ name: string }> }; played_at: string }>;
            };
            const output = data.items.map(i => {
              const artists = i.track.artists.map(a => a.name).join(', ');
              return `${i.played_at.slice(0, 16)} — ${i.track.name} by ${artists}`;
            }).join('\n');
            return ok(output || 'No recent tracks');
          }
        }

        return fail(`Unknown action: ${action}`);
      } catch (err) {
        return fail(`Spotify failed: ${(err as Error).message}`);
      }
    },
  };
}
