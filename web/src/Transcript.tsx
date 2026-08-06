import { useEffect, useRef } from 'react';
import type { Entry } from './protocol';
import { Markdown } from './markdown';

export function Transcript({ entries }: { entries: Entry[] }) {
  const endRef = useRef<HTMLDivElement | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);

  // Only auto-scroll when the reader is already at the bottom. Yanking the view
  // down while someone is reading back through a long tool output is the single
  // most irritating thing a streaming UI can do.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const onScroll = () => {
      pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    if (pinnedRef.current) endRef.current?.scrollIntoView({ block: 'end' });
  }, [entries]);

  return (
    <div className="transcript" ref={scrollerRef}>
      {entries.length === 0 && <p className="empty">No messages yet. Anything you send here runs on the laptop.</p>}
      {entries.map((entry, i) => <EntryView key={i} entry={entry} />)}
      <div ref={endRef} />
    </div>
  );
}

function EntryView({ entry }: { entry: Entry }) {
  switch (entry.kind) {
    case 'user':
      return <div className="entry entry--user">{entry.text}</div>;

    case 'assistant':
      return (
        <div className={`entry entry--assistant${entry.streaming ? ' is-streaming' : ''}`}>
          <Markdown text={entry.text} />
        </div>
      );

    case 'error':
      return <div className="entry entry--error">{entry.text}</div>;

    case 'tool':
      return (
        <details className={`tool${entry.result ? (entry.result.success ? ' ok' : ' bad') : ' pending'}`}>
          <summary>
            <span className="tool__name">{entry.name}</span>
            <span className="tool__hint">{summarize(entry.args)}</span>
          </summary>
          {entry.result && <pre className="tool__output">{entry.result.output || '(no output)'}</pre>}
        </details>
      );
  }
}

/** The one argument worth showing on a phone-width summary line. */
function summarize(args: Record<string, unknown>): string {
  for (const key of ['path', 'file_path', 'command', 'pattern', 'query', 'url']) {
    const v = args?.[key];
    if (typeof v === 'string') return v.length > 60 ? `${v.slice(0, 57)}…` : v;
  }
  const first = args ? Object.values(args)[0] : undefined;
  return typeof first === 'string' && first.length < 60 ? first : '';
}
