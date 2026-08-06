import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { applySingleEdit, normalizeWithMap, uniformIndentDelta, registerCodingTools } from '../src/tools/coding.js';
import { ToolRegistry } from '../src/tools/registry.js';

/**
 * Regression tests for the whitespace-fuzzy edit path.
 *
 * This was the largest single source of tool failures in the harness eval —
 * `edit_file` reported "Whitespace-fuzzy match found but could not locate exact
 * position" on 4 of 27 calls, an error whose advice ("read the file and retry
 * with exact content") is the thing the model had just done. Counting and
 * locating were two different searches that could disagree.
 */

const FILE = [
  'export function render(op) {',
  '  switch (op.type) {',
  '    case "add_column":',
  '      return `ALTER TABLE ${op.table} ADD COLUMN ${op.column}`;',
  '    default:',
  '      throw new Error("unknown");',
  '  }',
  '}',
  '',
].join('\n');

const apply = (content: string, oldStr: string, newStr: string, replaceAll = false) =>
  applySingleEdit(content, oldStr, newStr, replaceAll, 'file.ts');

describe('normalizeWithMap', () => {
  it('collapses runs of spaces and tabs to one space', () => {
    expect(normalizeWithMap('a \t  b').text).toBe('a b');
  });

  it('turns CRLF into LF', () => {
    expect(normalizeWithMap('a\r\nb').text).toBe('a\nb');
  });

  it('maps each output character back to where it came from', () => {
    const { text, map } = normalizeWithMap('a   b');
    expect(text).toBe('a b');
    expect(map).toEqual([0, 1, 4]); // 'a', the run starting at 1, then 'b' at 4
  });

  it('produces a map the same length as the text', () => {
    for (const s of ['', 'plain', '  lead', 'trail  ', 'a\r\n  b\tc']) {
      const { text, map } = normalizeWithMap(s);
      expect(map).toHaveLength(text.length);
    }
  });
});

describe('applySingleEdit — exact matching is unchanged', () => {
  it('replaces a unique exact match', () => {
    const r = apply(FILE, '      throw new Error("unknown");', '      return null;');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.updated).toContain('      return null;');
  });

  it('refuses a non-unique match without replace_all', () => {
    const r = apply('x\nx\n', 'x', 'y');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/must be unique/);
  });

  it('replaces every occurrence with replace_all', () => {
    const r = apply('x\nx\n', 'x', 'y', true);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.updated).toBe('y\ny\n');
  });
});

describe('applySingleEdit — the regression', () => {
  it('applies a match whose indentation differs from the file', () => {
    // The exact case that produced "could not locate exact position": the
    // needle is real but its leading whitespace does not match the file's.
    const r = apply(FILE, 'case "add_column":', 'case "add_column": // handled', false);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.updated).toContain('case "add_column": // handled');
  });

  it('applies a multi-line match whose indentation WIDTH differs', () => {
    // Normalization collapses runs of whitespace; it does not delete them. So
    // across a newline the indentation has to be present but may be any width
    // — which is the realistic case (a model re-indenting what it read).
    const needle = '  switch (op.type) {\n        case "add_column":';
    const r = apply(FILE, needle, '  switch (op.type) {\n    case "renamed":');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.updated).toContain('case "renamed":');
  });

  it('applies a needle that lost its base indent, restoring the FILE\'s', () => {
    // read_file prints numbered lines, so a model reconstructing the original
    // often strips the wrong prefix — dropping the same amount from every line.
    // This was the most common tool failure in the eval, on files the model had
    // just read. A unique match now applies, re-indented to the file.
    const needle = 'switch (op.type) {\n  case "add_column":';           // 2 less than the file
    const repl   = 'switch (op.type) {\n  case "renamed":';
    const r = apply(FILE, needle, repl);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.updated).toContain('  switch (op.type) {');
      expect(r.updated).toContain('    case "renamed":');
      expect(r.updated).toContain('      throw new Error("unknown");'); // rest untouched
    }
  });

  it('refuses a needle that flattened the block\'s relative indentation', () => {
    // Re-indenting that uniformly would rewrite the block's structure — a
    // behaviour change in Python and an unwanted reformat everywhere else.
    const r = apply(FILE, 'switch (op.type) {\ncase "add_column":', 'X\nY');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not found|different indentation/);
  });

  it('refuses when the de-indented match is ambiguous', () => {
    // Absorbing a formatting slip is fine; guessing which of two sites was
    // meant is not.
    const twice = 'if (a) {\n  go();\n}\nif (b) {\n  go();\n}\n';
    const r = apply(twice, 'go();', 'stop();');
    expect(r.ok).toBe(false);
  });

  it('matches an LF needle against a CRLF file', () => {
    const crlf = FILE.replace(/\n/g, '\r\n');
    const r = apply(crlf, '  }\n}', '  }\n}\n// done');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.updated).toContain('// done');
  });

  it('never reports a match it cannot locate', () => {
    // The old failure mode in one assertion: whatever the counter finds, the
    // locator must be able to place. There is no longer a code path that says
    // "found but cannot locate".
    const needles = [
      'case "add_column":',
      '   switch (op.type) {',
      'return `ALTER TABLE ${op.table} ADD COLUMN ${op.column}`;',
      '}\n',
    ];
    for (const n of needles) {
      const r = apply(FILE, n, 'REPLACED');
      if (!r.ok) expect(r.error).not.toMatch(/could not locate exact position/);
    }
  });

  it('preserves the rest of the file byte for byte', () => {
    const r = apply(FILE, 'case "add_column":', 'case "add_column":');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.updated).toBe(FILE);
  });
});

describe('applySingleEdit — replace_all on the fuzzy path', () => {
  it('replaces EVERY fuzzy occurrence, not just the first', () => {
    // The old code called content.replace(actualOld, newStr) here, which
    // replaces one occurrence — silently ignoring replace_all.
    const content = 'a  b\nzzz\na    b\nzzz\na\tb\n';
    const r = apply(content, 'a b', 'X', true);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.updated).toBe('X\nzzz\nX\nzzz\nX\n');
      expect(r.matchCount).toBe(3);
    }
  });

  it('still refuses multiple fuzzy matches without replace_all', () => {
    const r = apply('a  b\na    b\n', 'a b', 'X');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/found 2 times/);
  });

  it('consumes the whitespace run it matched, leaving no debris', () => {
    const r = apply('x   y', 'x y', 'z');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.updated).toBe('z');
  });
});

describe('applySingleEdit — a miss must be recoverable', () => {
  it('reports not-found with a nearby-line hint', () => {
    const r = apply(FILE, 'case "drop_column":', 'x');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/not found in file\.ts/);
      expect(r.error).toMatch(/Read the file first/);
    }
  });

  it('still describes a miss when the text is ambiguous rather than absent', () => {
    // describeMiss remains the path for anything not uniquely resolvable; it
    // must name where the code actually is instead of just saying "not found".
    const twice = 'if (a) {\n  go();\n}\nif (b) {\n  go();\n}\n';
    const r = apply(twice, 'go();', 'stop();');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not found|found 2 times/);
  });

  it('spots read_file line numbers pasted into old_string', () => {
    // read_file prints "   12  code"; a model copying from that output brings
    // the numbers along and every match fails for a reason nothing explains.
    const numbered = '    2    switch (op.type) {\n    3      case "add_column":';
    const r = apply(FILE, numbered, 'X');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/line numbers from read_file/);
      expect(r.error).toContain('switch (op.type) {');
      expect(r.error).not.toMatch(/^\s*\d+\s\s+switch/m);
    }
  });

  it('does not cry line-numbers at code that legitimately starts with a number', () => {
    const r = apply('const x = 42;\n', '99 bottles', 'X');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).not.toMatch(/line numbers from read_file/);
  });
});

describe('edit_file end to end', () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'vcode-edit-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('writes an indentation-mismatched edit through the real tool', async () => {
    const path = join(tmp, 'render.ts');
    writeFileSync(path, FILE);

    const registry = new ToolRegistry();
    for (const t of registerCodingTools()) registry.register(t);

    const result = await registry.execute('edit_file', {
      path,
      old_string: 'case "add_column":',
      new_string: 'case "add_column": // handled',
    });

    expect(result.success).toBe(true);
    expect(readFileSync(path, 'utf-8')).toContain('case "add_column": // handled');
  });
});

describe('multi_edit reports every failure at once', () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'vcode-medit-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  const run = async (edits: Array<{ old_string: string; new_string: string }>) => {
    const path = join(tmp, 'render.ts');
    writeFileSync(path, FILE);
    const registry = new ToolRegistry();
    for (const t of registerCodingTools()) registry.register(t);
    const result = await registry.execute('multi_edit', { path, edits });
    return { result, after: readFileSync(path, 'utf-8') };
  };

  it('names both broken edits instead of one per round trip', async () => {
    // Bailing on the first failure cost a full retry to discover the second,
    // and the whole batch was rewritten each round.
    const { result } = await run([
      { old_string: 'case "nope_one":', new_string: 'x' },
      { old_string: 'case "nope_two":', new_string: 'y' },
    ]);
    expect(result.success).toBe(false);
    expect(result.error).toContain('op 0');
    expect(result.error).toContain('op 1');
    expect(result.error).toMatch(/2 of 2 edits failed/);
  });

  it('says which edits were fine so they need not be re-derived', async () => {
    const { result } = await run([
      { old_string: '      throw new Error("unknown");', new_string: '      return null;' },
      { old_string: 'case "nope":', new_string: 'y' },
    ]);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/The other 1 edit matched/);
  });

  it('still writes nothing when any edit fails', async () => {
    const { result, after } = await run([
      { old_string: '      throw new Error("unknown");', new_string: '      return null;' },
      { old_string: 'case "nope":', new_string: 'y' },
    ]);
    expect(result.success).toBe(false);
    expect(after).toBe(FILE); // a half-applied file is worse than a rejected call
  });

  it('applies every edit when they all match', async () => {
    const { result, after } = await run([
      { old_string: '      throw new Error("unknown");', new_string: '      return null;' },
      { old_string: 'case "add_column":', new_string: 'case "add_col":' },
    ]);
    expect(result.success).toBe(true);
    expect(after).toContain('return null;');
    expect(after).toContain('case "add_col":');
  });
});

describe('an OVER-indented needle is absorbed too', () => {
  // read_file prints "   21      case \"add_column\":". Stripping the line number
  // by eye can leave spaces behind, producing a needle indented MORE than the
  // file. That direction used to bail out of the fuzzy path entirely and land in
  // describeMiss — which located the match and handed it back for the model to
  // retry, costing a whole turn. It was the most frequent tool error in the
  // 15-task baseline, hitting five of eight tasks.

  it('applies a needle indented deeper than the file', () => {
    const r = apply(FILE,
      '        case "add_column":\n          return `ALTER TABLE ${op.table} ADD COLUMN ${op.column}`;',
      '        case "renamed":\n          return `RENAMED`;');
    expect(r.ok).toBe(true);
    if (r.ok) {
      // The file's own 4/6 indentation wins, not the needle's 8/10.
      expect(r.updated).toContain('    case "renamed":');
      expect(r.updated).toContain('      return `RENAMED`;');
      expect(r.updated).not.toContain('        case "renamed":');
    }
  });

  it('keeps the rest of the file byte-identical', () => {
    const r = apply(FILE, '      default:', '      default: // fell through');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.updated).toBe(FILE.replace('    default:', '    default: // fell through'));
    }
  });

  it('writes verbatim rather than mangling a replacement it cannot dedent', () => {
    // The needle is the real region, over-indented by 4. But new_string's second
    // line sits at column 0, so stripping 4 spaces from it would eat real
    // characters. The shift is abandoned and new_string goes in as written —
    // cosmetically wrong, which is what this path always did, and strictly
    // better than corrupting the line.
    const r = apply(FILE,
      '        case "add_column":\n          return `ALTER TABLE ${op.table} ADD COLUMN ${op.column}`;',
      '        case "renamed":\nreturn 2;');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.updated).toContain('\nreturn 2;');
      expect(r.updated).toContain('  switch (op.type) {');   // rest of the file intact
      expect(r.updated).toContain('      throw new Error("unknown");');
    }
  });

  it('does not try to shift tabs-versus-spaces', () => {
    // Whitespace normalization still matches these, so the edit applies — but
    // neither indent is a prefix of the other, so no shift is invented. The
    // replacement goes in as written rather than being guessed into tabs.
    const src = '\tif (a) {\n\t\treturn 1;\n\t}\n';
    const r = apply(src, '  if (a) {\n    return 1;\n  }', '  if (b) {\n    return 2;\n  }');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.updated).toBe('  if (b) {\n    return 2;\n  }\n');
  });

  it('still refuses an ambiguous over-indented match', () => {
    const src = [
      'function a() {',
      '  return 1;',
      '}',
      'function b() {',
      '  return 1;',
      '}',
      '',
    ].join('\n');
    const r = apply(src, '      return 1;', '      return 2;');
    expect(r.ok).toBe(false);
  });
});

describe('the file keeps its own indentation', () => {
  it('re-indents the replacement to the file, not to the model\'s guess', () => {
    // Whitespace-insensitive matching lets the needle be indented differently
    // from the region it matched. Writing new_string verbatim then silently
    // reformats that region — invisible in a nested block, and in Python a
    // change to what the code means.
    const r = apply(FILE, 'switch (op.type) {\n  case "add_column":',
                          'switch (op.type) {\n  case "renamed":');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.updated).toContain('  switch (op.type) {');
      expect(r.updated).toContain('    case "renamed":');   // file's 4, not the needle's 2
      expect(r.updated).toContain('      throw new Error("unknown");');
    }
  });

  it('leaves an exactly-matching replacement completely alone', () => {
    const r = apply(FILE, '    case "add_column":', '    case "renamed":');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.updated).toBe(FILE.replace('    case "add_column":', '    case "renamed":'));
  });

  it('does not splice indentation into a match that starts mid-line', () => {
    // `const |x = 1` — the match begins after real code, so there is no
    // line-level indentation to restore and adding any would corrupt the line.
    const src = '  const x = 1;\n';
    const r = apply(src, 'x = 1;', 'y = 2;');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.updated).toBe('  const y = 2;\n');
  });

  it('refuses to re-indent when the needle flattened the block', () => {
    const delta = uniformIndentDelta('  a\n    b', 'a\nb');
    expect(delta).toEqual({ indent: '', dedent: false }); // 2 vs 4 — not uniform, so no reformat
  });

  it('reports a uniform shift', () => {
    expect(uniformIndentDelta('    a\n      b', '  a\n    b')).toEqual({ indent: '  ', dedent: false });
  });

  it('reports a uniform shift in the other direction', () => {
    // The needle is deeper than the file: the shift must be REMOVED from the
    // replacement, not added. This used to return '' and leave new_string at
    // the model's indentation.
    expect(uniformIndentDelta('  a\n    b', '    a\n      b')).toEqual({ indent: '  ', dedent: true });
  });

  it('refuses to pick a side between tabs and spaces', () => {
    expect(uniformIndentDelta('\ta', '  a')).toEqual({ indent: '', dedent: false });
  });
});
