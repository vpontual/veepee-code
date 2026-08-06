import { describe, it, expect } from 'vitest';
import { parseBlocks, splitInlineCode } from '../web/src/markdown-parse.js';

describe('parseBlocks', () => {
  it('returns plain text as one prose block', () => {
    expect(parseBlocks('hello there')).toEqual([{ kind: 'prose', body: 'hello there' }]);
  });

  it('pulls a fenced block out of surrounding prose', () => {
    const blocks = parseBlocks('before\n```ts\nconst a = 1;\n```\nafter');
    expect(blocks).toEqual([
      { kind: 'prose', body: 'before' },
      { kind: 'code', lang: 'ts', body: 'const a = 1;' },
      { kind: 'prose', body: 'after' },
    ]);
  });

  it('treats an UNTERMINATED fence as code to the end', () => {
    // This is the normal state of a response that is still streaming. Treating
    // it as prose until the closing fence arrives makes the block snap from
    // paragraph to code mid-read and reflows the transcript underneath.
    const blocks = parseBlocks('here you go\n```py\nx = 1\ny = 2');
    expect(blocks).toEqual([
      { kind: 'prose', body: 'here you go' },
      { kind: 'code', lang: 'py', body: 'x = 1\ny = 2' },
    ]);
  });

  it('handles a fence with no language', () => {
    expect(parseBlocks('```\nraw\n```')).toEqual([{ kind: 'code', lang: '', body: 'raw' }]);
  });

  it('handles an indented fence', () => {
    expect(parseBlocks('  ```js\n  a\n  ```')).toEqual([{ kind: 'code', lang: 'js', body: '  a' }]);
  });

  it('keeps several blocks in order', () => {
    const blocks = parseBlocks('a\n```\n1\n```\nb\n```\n2\n```\nc');
    expect(blocks.map((b) => b.kind)).toEqual(['prose', 'code', 'prose', 'code', 'prose']);
    expect(blocks.map((b) => b.body)).toEqual(['a', '1', 'b', '2', 'c']);
  });

  it('does not lose an empty code block', () => {
    expect(parseBlocks('```\n```')).toEqual([{ kind: 'code', lang: '', body: '' }]);
  });

  it('leaves angle brackets alone — they are escaped by React, not here', () => {
    const blocks = parseBlocks('```html\n<script>alert(1)</script>\n```');
    expect(blocks[0].body).toBe('<script>alert(1)</script>');
  });
});

describe('splitInlineCode', () => {
  it('returns plain text unchanged', () => {
    expect(splitInlineCode('nothing here')).toEqual([{ code: false, text: 'nothing here' }]);
  });

  it('splits out inline code and drops the backticks', () => {
    expect(splitInlineCode('run `npm test` now')).toEqual([
      { code: false, text: 'run ' },
      { code: true, text: 'npm test' },
      { code: false, text: ' now' },
    ]);
  });

  it('handles several spans', () => {
    expect(splitInlineCode('`a` and `b`')).toEqual([
      { code: true, text: 'a' },
      { code: false, text: ' and ' },
      { code: true, text: 'b' },
    ]);
  });

  it('leaves an unpaired backtick as text', () => {
    expect(splitInlineCode('a ` b')).toEqual([{ code: false, text: 'a ` b' }]);
  });

  it('does not span a newline', () => {
    // A stray backtick on one line must not swallow the next line as code.
    expect(splitInlineCode('a `b\nc` d')).toEqual([{ code: false, text: 'a `b\nc` d' }]);
  });
});
