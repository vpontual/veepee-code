import { EVENT_NAMES, type ServerEvent, type ConnectionState } from './protocol';

const TOKEN_KEY = 'vcode.rc.token';

export function storedToken(): string {
  const fromUrl = new URLSearchParams(location.search).get('token');
  if (fromUrl) {
    localStorage.setItem(TOKEN_KEY, fromUrl);
    // Drop it from the address bar so the token is not sitting in screenshots,
    // shared links or the browser's history entry for this page.
    history.replaceState(null, '', location.pathname);
    return fromUrl;
  }
  return localStorage.getItem(TOKEN_KEY) ?? '';
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

interface ClientHandlers {
  onEvent(event: ServerEvent): void;
  onState(state: ConnectionState): void;
}

/**
 * The SSE connection, with a reconnect policy that belongs here rather than
 * scattered through the view.
 *
 * The old inline client reconnected on a fixed timer with no ceiling and no
 * backoff, which on a phone that has walked out of WireGuard range means a
 * request every second forever. Backoff is exponential and capped; the state is
 * surfaced so the UI can say "retrying" instead of silently showing a
 * transcript that stopped updating ten minutes ago.
 */
export class RcClient {
  private source: EventSource | null = null;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(private readonly token: string, private readonly handlers: ClientHandlers) {}

  connect(): void {
    this.closed = false;
    this.open();
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.source?.close();
    this.source = null;
  }

  /**
   * Drop the stream and open a fresh one.
   *
   * Used after resuming a session: the server swaps the agent's context, but an
   * already-open SSE connection replays nothing, so without this the phone
   * would sit looking at the previous session's transcript.
   */
  reconnect(): void {
    this.attempt = 0;
    if (this.timer) clearTimeout(this.timer);
    this.open();
  }

  private open(): void {
    this.source?.close();
    this.handlers.onState(this.attempt === 0 ? 'connecting' : 'retrying');

    const url = `/rc/stream?token=${encodeURIComponent(this.token)}`;
    const es = new EventSource(url);
    this.source = es;

    es.onopen = () => {
      this.attempt = 0;
      this.handlers.onState('live');
    };

    for (const name of EVENT_NAMES) {
      es.addEventListener(name, (ev) => {
        try {
          const data = JSON.parse((ev as MessageEvent).data) as Record<string, unknown>;
          this.handlers.onEvent({ type: name, ...data } as ServerEvent);
        } catch {
          // A malformed frame must not kill the stream — the next one may be fine.
        }
      });
    }

    es.onerror = () => {
      if (this.closed) return;
      es.close();
      this.attempt += 1;
      // 1s, 2s, 4s … capped at 15s. Enough to ride out a suspend/resume or a
      // walk between access points without hammering a server that is down.
      const delay = Math.min(1000 * 2 ** (this.attempt - 1), 15_000);
      this.handlers.onState('retrying');
      this.timer = setTimeout(() => this.open(), delay);
    };
  }
}

async function post(path: string, token: string, body: unknown): Promise<Response> {
  return fetch(`/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

export interface SessionSummary {
  id: string;
  name: string;
  messageCount: number;
  updatedAt: string;
  model: string;
}

export async function listSessions(token: string): Promise<SessionSummary[]> {
  const res = await fetch('/rc/sessions', { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`sessions: ${res.status}`);
  const body = (await res.json()) as { sessions?: SessionSummary[] };
  return body.sessions ?? [];
}

export const resumeSession = (token: string, sessionId: string) =>
  post('rc/resume', token, { sessionId });

export const send = (token: string, message: string) => post('rc/send', token, { message });
export const abort = (token: string) => post('rc/abort', token, {});
export const respondToPermission = (token: string, callId: string, decision: 'y' | 'n') =>
  post('rc/approve', token, { callId, decision });
