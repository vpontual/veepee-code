import { useState, type ReactNode } from 'react';
import { parseBlocks, splitInlineCode } from './markdown-parse';

/**
 * Render agent output.
 *
 * Everything goes through React text nodes — no innerHTML anywhere, and so no
 * sanitiser to get wrong. Model output is untrusted input and routinely
 * contains angle brackets.
 */
export function Markdown({ text }: { text: string }): ReactNode {
  return (
    <>
      {parseBlocks(text).map((block, i) =>
        block.kind === 'code'
          ? <CodeBlock key={i} lang={block.lang} body={block.body} />
          : <p key={i} className="prose">{splitInlineCode(block.body).map((part, j) =>
              part.code ? <code key={j}>{part.text}</code> : <span key={j}>{part.text}</span>,
            )}</p>,
      )}
    </>
  );
}

function CodeBlock({ lang, body }: { lang: string; body: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(body);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // navigator.clipboard needs a secure context. Over plain http on the mesh
      // there isn't one, so the button does nothing rather than throwing.
    }
  };

  return (
    <div className="code">
      <div className="code__bar">
        <span>{lang || 'code'}</span>
        <button onClick={() => void copy()}>{copied ? 'copied' : 'copy'}</button>
      </div>
      <pre><code>{body}</code></pre>
    </div>
  );
}
