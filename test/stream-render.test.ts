/**
 * The streaming reply is formatted incrementally (formatStreamingAssistant).
 * Its output must be exactly what a full reformat (formatMessage) produces, at
 * every chunk, or the screen would show different text mid-stream and after.
 */
import { describe, it, expect } from 'vitest';
import { formatMessage, formatStreamingAssistant } from '../src/tui/components/MessageBlock.js';

const SAMPLES = [
  `## Plan\n\n- read the file\n- fix the bug\n  - nested item\n\n1. first\n2. second\n\n> a quote that is long enough to wrap around the terminal width at least once or twice here\n\n---\n\nPlain prose with **bold**, \`code\` and a [link](http://x). `.repeat(3),
  "Here is the fix:\n\n```ts\nfunction f(x: number) {\n  if (x < 0) return null;\n  return x * 2;\n}\n```\n\nAnd a shell block:\n\n```\nnpm test\n```\n\nDone.",
  'Unclosed code at the end:\n\n```python\ndef g():\n    return 1\n',
  '\n\nleading blank lines\n\n\n\nand several in a row\n',
  'x'.repeat(500) + '\n' + 'word '.repeat(200),
];

function chunks(text: string, seed: number): string[] {
  const out: string[] = [];
  let i = 0;
  let s = seed;
  while (i < text.length) {
    s = (s * 1103515245 + 12345) % 2147483648;
    const n = 1 + (s % 17);
    out.push(text.slice(i, i + n));
    i += n;
  }
  return out;
}

describe('formatStreamingAssistant', () => {
  for (const [si, sample] of SAMPLES.entries()) {
    for (const width of [40, 116]) {
      it(`matches a full reformat at every chunk (sample ${si}, width ${width})`, () => {
        let shown = '';
        for (const c of chunks(sample, si * 7 + width)) {
          shown += c;
          const expected = formatMessage({ role: 'assistant', content: shown }, width);
          expect(formatStreamingAssistant(shown, width)).toEqual(expected);
        }
      });
    }
  }

  it('starts over for a new reply', () => {
    formatStreamingAssistant('first reply\n\nwith lines\n', 80);
    const fresh = 'second\n';
    expect(formatStreamingAssistant(fresh, 80)).toEqual(formatMessage({ role: 'assistant', content: fresh }, 80));
  });
});
