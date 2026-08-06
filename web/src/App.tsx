import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RcClient, storedToken, send, abort, respondToPermission } from './client';
import type { ConnectionState, Entry, PendingPermission, QueuedAhead, ServerEvent } from './protocol';
import { Transcript } from './Transcript';
import { Composer } from './Composer';
import { Sessions } from './Sessions';

const STATE_LABEL: Record<ConnectionState, string> = {
  connecting: 'connecting',
  live: 'live',
  retrying: 'reconnecting',
  unauthorized: 'bad token',
};

export function App() {
  const [token, setToken] = useState(storedToken);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [state, setState] = useState<ConnectionState>('connecting');
  const [permission, setPermission] = useState<PendingPermission | null>(null);
  const [busy, setBusy] = useState(false);
  const [queued, setQueued] = useState<QueuedAhead>(null);
  const [showSessions, setShowSessions] = useState(false);
  const clientRef = useRef<RcClient | null>(null);

  const apply = useCallback((event: ServerEvent) => {
    setEntries((prev) => reduce(prev, event));
    if (event.type === 'user_message') setBusy(true);
    if (event.type === 'queued') setQueued(event.ahead);
    // Any output means our turn actually started, so the queue notice goes.
    if (event.type === 'text' || event.type === 'tool_call') setQueued(null);
    if (event.type === 'done' || event.type === 'error_event') { setBusy(false); setQueued(null); }
    if (event.type === 'permission_request') {
      setPermission({ callId: event.callId, tool: event.tool, args: event.args });
    }
  }, []);

  useEffect(() => {
    if (!token) return;
    const client = new RcClient(token, { onEvent: apply, onState: setState });
    clientRef.current = client;
    client.connect();
    return () => client.close();
  }, [token, apply]);

  const onSend = useCallback(async (text: string) => {
    if (!text.trim()) return;
    setBusy(true);
    // Optimistic: the server echoes user_message, but on a slow link the gap
    // between typing and seeing it is where people press send twice.
    setEntries((prev) => [...prev, { kind: 'user', text }]);
    try {
      await send(token, text);
    } catch {
      setEntries((prev) => [...prev, { kind: 'error', text: 'Could not reach vcode — message not sent.' }]);
      setBusy(false);
    }
  }, [token]);

  const onAbort = useCallback(() => { void abort(token); setBusy(false); }, [token]);

  const decide = useCallback(async (decision: 'y' | 'n') => {
    if (!permission) return;
    await respondToPermission(token, permission.callId, decision).catch(() => undefined);
    setPermission(null);
  }, [permission, token]);

  const onResumed = useCallback(() => {
    // The server swapped the agent's context. Drop what is on screen and pull a
    // fresh stream, which replays the resumed session's recent history.
    setEntries([]);
    setShowSessions(false);
    setBusy(false);
    setQueued(null);
    clientRef.current?.reconnect();
  }, []);

  const header = useMemo(() => (
    <header className="bar">
      <span className="logo">veepee<b>code</b></span>
      <button className="ghost" onClick={() => setShowSessions((v) => !v)}>sessions</button>
      <span className={`state state--${state}`}>{STATE_LABEL[state]}</span>
      {busy && <button className="stop" onClick={onAbort}>stop</button>}
    </header>
  ), [state, busy, onAbort]);

  if (!token) return <TokenGate onToken={setToken} />;

  return (
    <div className="app">
      {header}
      {showSessions && (
        <Sessions token={token} onResumed={onResumed} onClose={() => setShowSessions(false)} />
      )}
      <Transcript entries={entries} />
      {queued !== null && (
        <div className="queued" role="status">
          waiting — {queued === 1 ? 'one turn' : `${queued} turns`} ahead of yours
        </div>
      )}
      {permission && (
        <div className="permission" role="alertdialog" aria-label="Permission request">
          <div className="permission__what">
            <strong>{permission.tool}</strong>
            {permission.args ? <pre>{JSON.stringify(permission.args, null, 2)}</pre> : null}
          </div>
          <div className="permission__actions">
            <button className="deny" onClick={() => void decide('n')}>deny</button>
            <button className="allow" onClick={() => void decide('y')}>allow</button>
          </div>
        </div>
      )}
      <Composer busy={busy} onSend={onSend} />
    </div>
  );
}

function TokenGate({ onToken }: { onToken: (t: string) => void }) {
  const [value, setValue] = useState('');
  return (
    <form
      className="gate"
      onSubmit={(e) => { e.preventDefault(); if (value.trim()) { localStorage.setItem('vcode.rc.token', value.trim()); onToken(value.trim()); } }}
    >
      <span className="logo">veepee<b>code</b></span>
      <p>Paste the token from <code>/rc</code>, or open the QR link.</p>
      <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="token" autoFocus />
      <button type="submit">connect</button>
    </form>
  );
}

/**
 * Fold one server event into the transcript.
 *
 * Kept a pure function so the streaming-append rule is testable and lives in
 * one place: `text` frames extend the assistant entry that is currently
 * streaming, and anything else closes it.
 */
export function reduce(entries: Entry[], event: ServerEvent): Entry[] {
  const last = entries[entries.length - 1];

  switch (event.type) {
    case 'history':
      return [...entries, event.role === 'user'
        ? { kind: 'user', text: event.content }
        : { kind: 'assistant', text: event.content, streaming: false }];

    case 'user_message':
      // The server echoes what we already added optimistically.
      if (last?.kind === 'user' && last.text === event.content) return entries;
      return [...entries, { kind: 'user', text: event.content }];

    case 'text': {
      if (!event.content) return entries;
      if (last?.kind === 'assistant' && last.streaming) {
        return [...entries.slice(0, -1), { ...last, text: last.text + event.content }];
      }
      return [...entries, { kind: 'assistant', text: event.content, streaming: true }];
    }

    case 'tool_call':
      return [...close(entries), { kind: 'tool', name: event.name, args: event.args }];

    case 'tool_result': {
      // Attach to the most recent matching call rather than appending, so a
      // tool shows as one entry that resolves instead of two that must be
      // mentally paired.
      for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i];
        if (e.kind === 'tool' && e.name === event.name && !e.result) {
          const updated = [...entries];
          updated[i] = { ...e, result: { success: event.success, output: event.output } };
          return updated;
        }
      }
      return entries;
    }

    case 'done':
      return close(entries);

    case 'error_event':
      return [...close(entries), { kind: 'error', text: event.error }];

    default:
      return entries;
  }
}

function close(entries: Entry[]): Entry[] {
  const last = entries[entries.length - 1];
  if (last?.kind === 'assistant' && last.streaming) {
    return [...entries.slice(0, -1), { ...last, streaming: false }];
  }
  return entries;
}
