import { useEffect, useState } from 'react';
import { listSessions, resumeSession, type SessionSummary } from './client';

/**
 * Saved sessions, and switching between them.
 *
 * /rc/sessions and /rc/resume have existed on the server the whole time — the
 * inline UI simply never called them, so from the phone there was exactly one
 * conversation: whatever the laptop happened to be doing.
 */
export function Sessions({
  token,
  onResumed,
  onClose,
}: {
  token: string;
  onResumed: () => void;
  onClose: () => void;
}) {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [switching, setSwitching] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    listSessions(token)
      .then((s) => { if (live) setSessions(s); })
      .catch((e) => { if (live) setError(String(e)); });
    return () => { live = false; };
  }, [token]);

  const pick = async (id: string) => {
    setSwitching(id);
    try {
      const res = await resumeSession(token, id);
      if (!res.ok) throw new Error(`resume failed: ${res.status}`);
      onResumed();
    } catch (e) {
      setError(String(e));
      setSwitching(null);
    }
  };

  return (
    <div className="sheet" role="dialog" aria-label="Sessions">
      <div className="sheet__bar">
        <span>sessions</span>
        <button onClick={onClose} aria-label="Close">✕</button>
      </div>

      {error && <p className="sheet__error">{error}</p>}
      {!sessions && !error && <p className="sheet__note">loading…</p>}
      {sessions?.length === 0 && <p className="sheet__note">No saved sessions yet.</p>}

      <ul className="sheet__list">
        {sessions?.map((s) => (
          <li key={s.id}>
            <button onClick={() => void pick(s.id)} disabled={switching !== null}>
              <span className="sheet__name">{s.name || s.id}</span>
              <span className="sheet__meta">
                {s.messageCount} msg · {ago(s.updatedAt)}
                {switching === s.id ? ' · switching…' : ''}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Relative time, because an ISO timestamp on a phone tells you nothing at a glance. */
function ago(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const mins = Math.max(0, Math.round((Date.now() - then) / 60_000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
