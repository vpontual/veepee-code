import { useRef, useState } from 'react';

/**
 * The input.
 *
 * Enter sends, Shift+Enter makes a newline, and the box grows with the content
 * up to a few lines — typing a multi-line prompt into a single-line input on a
 * phone is what makes people give up and walk to the laptop.
 */
export function Composer({ busy, onSend }: { busy: boolean; onSend: (text: string) => void }) {
  const [value, setValue] = useState('');
  const ref = useRef<HTMLTextAreaElement | null>(null);

  const submit = () => {
    const text = value.trim();
    if (!text) return;
    onSend(text);
    setValue('');
    if (ref.current) ref.current.style.height = 'auto';
  };

  return (
    <form
      className="composer"
      onSubmit={(e) => { e.preventDefault(); submit(); }}
    >
      <textarea
        ref={ref}
        value={value}
        rows={1}
        placeholder={busy ? 'queued — will send when the turn finishes' : 'Ask vcode…'}
        onChange={(e) => {
          setValue(e.target.value);
          const el = e.target;
          el.style.height = 'auto';
          el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
        }}
      />
      <button type="submit" disabled={!value.trim()} aria-label="Send">↑</button>
    </form>
  );
}
