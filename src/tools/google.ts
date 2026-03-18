import { z } from 'zod';
import type { ToolDef } from './types.js';
import { ok, fail } from './types.js';
import type { Config } from '../config.js';

export function registerGoogleTools(config: Config): ToolDef[] {
  if (!config.google) return [];

  const auth = config.google;
  let accessToken: string | null = null;
  let tokenExpiry = 0;

  async function getToken(): Promise<string> {
    if (accessToken && Date.now() < tokenExpiry) return accessToken;

    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: auth.clientId,
        client_secret: auth.clientSecret,
        refresh_token: auth.refreshToken,
        grant_type: 'refresh_token',
      }),
    });

    if (!res.ok) throw new Error(`Token refresh failed: ${res.status}`);
    const data = await res.json() as { access_token: string; expires_in: number };
    accessToken = data.access_token;
    tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
    return accessToken;
  }

  async function googleApi(url: string, method = 'GET', body?: string): Promise<unknown> {
    const token = await getToken();
    const res = await fetch(url, {
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body,
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`Google API ${res.status}: ${await res.text()}`);
    if (res.status === 204) return {};
    return res.json();
  }

  return [
    createEmailTool(googleApi),
    createCalendarTool(googleApi),
    createDriveTool(googleApi),
    createDocsTool(googleApi),
    createSheetsTool(googleApi),
    createNotesTool(googleApi),
  ];
}

type ApiCall = (url: string, method?: string, body?: string) => Promise<unknown>;

function createEmailTool(api: ApiCall): ToolDef {
  return {
    name: 'email',
    description: 'Read and send Gmail emails. List inbox, read specific emails, send new emails, and search.',
    schema: z.object({
      action: z.enum(['inbox', 'read', 'send', 'search']).describe('Email action'),
      message_id: z.string().optional().describe('Message ID to read'),
      to: z.string().optional().describe('Recipient email address'),
      subject: z.string().optional().describe('Email subject'),
      body: z.string().optional().describe('Email body'),
      query: z.string().optional().describe('Search query (Gmail search syntax)'),
      max_results: z.number().optional().describe('Max results (default 10)'),
    }),
    execute: async (params) => {
      try {
        const action = params.action as string;
        const maxResults = (params.max_results as number) || 10;

        switch (action) {
          case 'inbox': {
            const data = await api(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${maxResults}&labelIds=INBOX`) as {
              messages?: Array<{ id: string }>;
            };
            if (!data.messages?.length) return ok('Inbox is empty');

            const summaries: string[] = [];
            for (const msg of data.messages.slice(0, 5)) {
              const full = await api(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`) as {
                id: string;
                payload: { headers: Array<{ name: string; value: string }> };
                snippet: string;
              };
              const headers = Object.fromEntries(full.payload.headers.map(h => [h.name, h.value]));
              summaries.push(`[${msg.id}] From: ${headers.From}\n  Subject: ${headers.Subject}\n  ${full.snippet?.slice(0, 100)}`);
            }
            return ok(`${data.messages.length} messages:\n\n${summaries.join('\n\n')}`);
          }

          case 'read': {
            const id = params.message_id as string;
            if (!id) return fail('message_id is required');
            const msg = await api(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`) as {
              payload: { headers: Array<{ name: string; value: string }>; body?: { data?: string }; parts?: Array<{ mimeType: string; body?: { data?: string } }> };
            };
            const headers = Object.fromEntries(msg.payload.headers.map(h => [h.name, h.value]));

            let body = '';
            if (msg.payload.body?.data) {
              body = Buffer.from(msg.payload.body.data, 'base64url').toString('utf-8');
            } else if (msg.payload.parts) {
              const textPart = msg.payload.parts.find(p => p.mimeType === 'text/plain');
              if (textPart?.body?.data) {
                body = Buffer.from(textPart.body.data, 'base64url').toString('utf-8');
              }
            }

            return ok(`From: ${headers.From}\nTo: ${headers.To}\nSubject: ${headers.Subject}\nDate: ${headers.Date}\n\n${body.slice(0, 5000)}`);
          }

          case 'send': {
            const to = params.to as string;
            const subject = params.subject as string;
            const body = params.body as string;
            if (!to || !subject || !body) return fail('to, subject, and body are required');

            const raw = Buffer.from(
              `To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`
            ).toString('base64url');

            const result = await api('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', 'POST', JSON.stringify({ raw })) as { id: string };
            return ok(`Email sent (ID: ${result.id})`);
          }

          case 'search': {
            const query = params.query as string;
            if (!query) return fail('query is required');
            const data = await api(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${maxResults}&q=${encodeURIComponent(query)}`) as {
              messages?: Array<{ id: string }>;
              resultSizeEstimate: number;
            };
            if (!data.messages?.length) return ok('No messages found');
            return ok(`Found ~${data.resultSizeEstimate} messages. IDs: ${data.messages.map(m => m.id).join(', ')}\nUse read action with a message_id to read one.`);
          }
        }

        return fail(`Unknown action: ${action}`);
      } catch (err) {
        return fail(`Email failed: ${(err as Error).message}`);
      }
    },
  };
}

function createCalendarTool(api: ApiCall): ToolDef {
  return {
    name: 'calendar',
    description: 'Manage Google Calendar: list upcoming events, create events, check availability.',
    schema: z.object({
      action: z.enum(['upcoming', 'create', 'today']).describe('Calendar action'),
      summary: z.string().optional().describe('Event title'),
      start: z.string().optional().describe('Start time ISO 8601 (e.g. "2026-03-20T10:00:00-07:00")'),
      end: z.string().optional().describe('End time ISO 8601'),
      description: z.string().optional().describe('Event description'),
      max_results: z.number().optional().describe('Max events (default 10)'),
    }),
    execute: async (params) => {
      try {
        const action = params.action as string;

        switch (action) {
          case 'today':
          case 'upcoming': {
            const now = new Date();
            const timeMin = action === 'today'
              ? new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString()
              : now.toISOString();
            const timeMax = action === 'today'
              ? new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString()
              : undefined;

            let url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?orderBy=startTime&singleEvents=true&timeMin=${encodeURIComponent(timeMin)}&maxResults=${(params.max_results as number) || 10}`;
            if (timeMax) url += `&timeMax=${encodeURIComponent(timeMax)}`;

            const data = await api(url) as { items: Array<{ summary: string; start: { dateTime?: string; date?: string }; end: { dateTime?: string; date?: string } }> };
            if (!data.items?.length) return ok('No events found');

            const output = data.items.map(e => {
              const start = e.start.dateTime || e.start.date || '?';
              const end = e.end.dateTime || e.end.date || '?';
              return `${start} → ${end}: ${e.summary}`;
            }).join('\n');
            return ok(output);
          }

          case 'create': {
            const summary = params.summary as string;
            const start = params.start as string;
            const end = params.end as string;
            if (!summary || !start || !end) return fail('summary, start, and end are required');

            const event = await api('https://www.googleapis.com/calendar/v3/calendars/primary/events', 'POST', JSON.stringify({
              summary,
              description: params.description || '',
              start: { dateTime: start },
              end: { dateTime: end },
            })) as { htmlLink: string };
            return ok(`Event created: ${event.htmlLink}`);
          }
        }

        return fail(`Unknown action: ${action}`);
      } catch (err) {
        return fail(`Calendar failed: ${(err as Error).message}`);
      }
    },
  };
}

function createDriveTool(api: ApiCall): ToolDef {
  return {
    name: 'google_drive',
    description: 'Search and manage Google Drive files: list, search, read content, upload.',
    schema: z.object({
      action: z.enum(['list', 'search', 'read']).describe('Drive action'),
      query: z.string().optional().describe('Search query or file ID'),
      max_results: z.number().optional().describe('Max results (default 10)'),
    }),
    execute: async (params) => {
      try {
        const action = params.action as string;
        const maxResults = (params.max_results as number) || 10;

        switch (action) {
          case 'list': {
            const data = await api(`https://www.googleapis.com/drive/v3/files?pageSize=${maxResults}&fields=files(id,name,mimeType,modifiedTime)&orderBy=modifiedTime desc`) as {
              files: Array<{ id: string; name: string; mimeType: string; modifiedTime: string }>;
            };
            const output = data.files.map(f => `[${f.id}] ${f.name} (${f.mimeType}, ${f.modifiedTime.slice(0, 10)})`).join('\n');
            return ok(output || 'No files');
          }

          case 'search': {
            const query = params.query as string;
            if (!query) return fail('query is required');
            const data = await api(`https://www.googleapis.com/drive/v3/files?q=name contains '${query.replace(/'/g, "\\'")}'&pageSize=${maxResults}&fields=files(id,name,mimeType)`) as {
              files: Array<{ id: string; name: string; mimeType: string }>;
            };
            const output = data.files.map(f => `[${f.id}] ${f.name} (${f.mimeType})`).join('\n');
            return ok(output || 'No files found');
          }

          case 'read': {
            const fileId = params.query as string;
            if (!fileId) return fail('file ID is required in query field');
            const meta = await api(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=name,mimeType`) as { name: string; mimeType: string };

            if (meta.mimeType.includes('google-apps.document')) {
              const content = await api(`https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain`);
              return ok(`${meta.name}:\n${String(content).slice(0, 10000)}`);
            }

            return ok(`File: ${meta.name} (${meta.mimeType}). Use export for Google Docs, or download for binary files.`);
          }
        }

        return fail(`Unknown action: ${action}`);
      } catch (err) {
        return fail(`Drive failed: ${(err as Error).message}`);
      }
    },
  };
}

function createDocsTool(api: ApiCall): ToolDef {
  return {
    name: 'google_docs',
    description: 'Read and create Google Docs documents.',
    schema: z.object({
      action: z.enum(['read', 'create']).describe('Docs action'),
      document_id: z.string().optional().describe('Document ID to read'),
      title: z.string().optional().describe('Title for new document'),
      content: z.string().optional().describe('Content for new document'),
    }),
    execute: async (params) => {
      try {
        const action = params.action as string;

        if (action === 'read') {
          const docId = params.document_id as string;
          if (!docId) return fail('document_id is required');
          const content = await api(`https://www.googleapis.com/drive/v3/files/${docId}/export?mimeType=text/plain`);
          return ok(String(content).slice(0, 10000));
        }

        if (action === 'create') {
          const title = params.title as string;
          if (!title) return fail('title is required');
          const doc = await api('https://docs.googleapis.com/v1/documents', 'POST', JSON.stringify({ title })) as { documentId: string };

          if (params.content) {
            await api(`https://docs.googleapis.com/v1/documents/${doc.documentId}:batchUpdate`, 'POST', JSON.stringify({
              requests: [{ insertText: { location: { index: 1 }, text: params.content as string } }],
            }));
          }

          return ok(`Created document: ${doc.documentId}`);
        }

        return fail(`Unknown action: ${action}`);
      } catch (err) {
        return fail(`Docs failed: ${(err as Error).message}`);
      }
    },
  };
}

function createSheetsTool(api: ApiCall): ToolDef {
  return {
    name: 'google_sheets',
    description: 'Read and write Google Sheets spreadsheets.',
    schema: z.object({
      action: z.enum(['read', 'write', 'create']).describe('Sheets action'),
      spreadsheet_id: z.string().optional().describe('Spreadsheet ID'),
      range: z.string().optional().describe('Cell range (e.g. "Sheet1!A1:D10")'),
      values: z.string().optional().describe('Values as JSON 2D array (e.g. [["a","b"],["c","d"]])'),
      title: z.string().optional().describe('Title for new spreadsheet'),
    }),
    execute: async (params) => {
      try {
        const action = params.action as string;

        if (action === 'read') {
          const id = params.spreadsheet_id as string;
          const range = params.range as string;
          if (!id || !range) return fail('spreadsheet_id and range are required');
          const data = await api(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent(range)}`) as {
            values: string[][];
          };
          if (!data.values?.length) return ok('No data in range');
          return ok(data.values.map(row => row.join('\t')).join('\n'));
        }

        if (action === 'write') {
          const id = params.spreadsheet_id as string;
          const range = params.range as string;
          const values = params.values as string;
          if (!id || !range || !values) return fail('spreadsheet_id, range, and values are required');
          let parsed: unknown[][];
          try { parsed = JSON.parse(values); } catch { return fail('Invalid values JSON'); }
          await api(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`, 'PUT', JSON.stringify({ values: parsed }));
          return ok(`Wrote to ${range}`);
        }

        if (action === 'create') {
          const title = params.title as string;
          if (!title) return fail('title is required');
          const sheet = await api('https://sheets.googleapis.com/v4/spreadsheets', 'POST', JSON.stringify({
            properties: { title },
          })) as { spreadsheetId: string; spreadsheetUrl: string };
          return ok(`Created spreadsheet: ${sheet.spreadsheetUrl}`);
        }

        return fail(`Unknown action: ${action}`);
      } catch (err) {
        return fail(`Sheets failed: ${(err as Error).message}`);
      }
    },
  };
}

function createNotesTool(api: ApiCall): ToolDef {
  return {
    name: 'notes',
    description: 'Manage Google Tasks as a notes/todo system. List, create, and complete tasks.',
    schema: z.object({
      action: z.enum(['list', 'create', 'complete']).describe('Notes/tasks action'),
      title: z.string().optional().describe('Task title'),
      notes: z.string().optional().describe('Task notes/description'),
      task_id: z.string().optional().describe('Task ID to complete'),
      tasklist_id: z.string().optional().describe('Task list ID (default: primary)'),
    }),
    execute: async (params) => {
      try {
        const action = params.action as string;
        const listId = (params.tasklist_id as string) || '@default';

        switch (action) {
          case 'list': {
            const data = await api(`https://tasks.googleapis.com/tasks/v1/lists/${listId}/tasks?maxResults=20`) as {
              items?: Array<{ id: string; title: string; notes?: string; status: string; due?: string }>;
            };
            if (!data.items?.length) return ok('No tasks');
            const output = data.items.map(t => {
              const status = t.status === 'completed' ? '✓' : '○';
              return `${status} [${t.id}] ${t.title}${t.notes ? '\n  ' + t.notes.slice(0, 100) : ''}`;
            }).join('\n');
            return ok(output);
          }

          case 'create': {
            const title = params.title as string;
            if (!title) return fail('title is required');
            const task = await api(`https://tasks.googleapis.com/tasks/v1/lists/${listId}/tasks`, 'POST', JSON.stringify({
              title,
              notes: params.notes || '',
            })) as { id: string };
            return ok(`Task created: ${task.id}`);
          }

          case 'complete': {
            const taskId = params.task_id as string;
            if (!taskId) return fail('task_id is required');
            await api(`https://tasks.googleapis.com/tasks/v1/lists/${listId}/tasks/${taskId}`, 'PATCH', JSON.stringify({ status: 'completed' }));
            return ok(`Task ${taskId} completed`);
          }
        }

        return fail(`Unknown action: ${action}`);
      } catch (err) {
        return fail(`Notes failed: ${(err as Error).message}`);
      }
    },
  };
}
