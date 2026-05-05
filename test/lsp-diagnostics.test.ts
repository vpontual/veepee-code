import { describe, it, expect } from 'vitest';
import { formatDiagnostic, formatDiagnostics, type LabeledDiagnostic } from '../src/lsp/diagnostics.js';
import { DiagnosticSeverity, type Diagnostic } from 'vscode-languageserver-protocol';
import { pathToFileUri } from '../src/lsp/uri.js';

function diag(opts: {
  severity?: DiagnosticSeverity;
  line?: number;
  character?: number;
  code?: string | number;
  message?: string;
}): Diagnostic {
  return {
    severity: opts.severity ?? DiagnosticSeverity.Error,
    range: {
      start: { line: opts.line ?? 0, character: opts.character ?? 0 },
      end: { line: opts.line ?? 0, character: (opts.character ?? 0) + 1 },
    },
    code: opts.code,
    message: opts.message ?? 'something is broken',
  };
}

function labeled(source: string, path: string, d: Diagnostic): LabeledDiagnostic {
  return { source, path, diagnostic: d };
}

describe('formatDiagnostic', () => {
  it('renders Error with code and 1-indexed line/column', () => {
    const d = diag({ line: 41, character: 9, code: 2322, message: "Type 'string' is not assignable to type 'number'." });
    const out = formatDiagnostic(labeled('typescript', '/proj/src/foo.ts', d), '/proj');
    expect(out).toBe(`Error: src/foo.ts:42:10 [typescript 2322] Type 'string' is not assignable to type 'number'.`);
  });

  it('renders Warn for warnings', () => {
    const d = diag({ severity: DiagnosticSeverity.Warning, line: 0, character: 0, code: 6133, message: 'unused' });
    const out = formatDiagnostic(labeled('typescript', '/proj/x.ts', d), '/proj');
    expect(out.startsWith('Warn:')).toBe(true);
  });

  it('omits the code when the diagnostic has none (gopls case)', () => {
    const d = diag({ message: 'broken thing' });
    delete (d as { code?: unknown }).code;
    const out = formatDiagnostic(labeled('gopls', '/proj/main.go', d), '/proj');
    expect(out).toContain('[gopls]');
    expect(out).not.toContain('undefined');
  });

  it('omits the code when it is empty string', () => {
    const d = diag({ code: '', message: 'hi' });
    const out = formatDiagnostic(labeled('gopls', '/proj/main.go', d), '/proj');
    expect(out).toContain('[gopls]');
  });

  it('trims trailing newlines from messages', () => {
    const d = diag({ message: 'broken\n' });
    const out = formatDiagnostic(labeled('typescript', '/proj/x.ts', d), '/proj');
    expect(out.endsWith('broken')).toBe(true);
  });
});

describe('formatDiagnostics', () => {
  function byUri(entries: Array<{ path: string; source: string; diags: Diagnostic[] }>) {
    const m = new Map<string, { source: string; diagnostics: Diagnostic[] }>();
    for (const e of entries) {
      m.set(pathToFileUri(e.path), { source: e.source, diagnostics: e.diags });
    }
    return m;
  }

  it('returns empty string when there are zero diagnostics', () => {
    expect(formatDiagnostics(new Map(), undefined, '/proj')).toBe('');
  });

  it('renders <file_diagnostics> + <project_diagnostics> + <diagnostic_summary> with currentFile', () => {
    const m = byUri([
      { path: '/proj/src/a.ts', source: 'typescript', diags: [
        diag({ line: 0, character: 0, code: 2322, message: 'mismatch' }),
        diag({ severity: DiagnosticSeverity.Warning, line: 5, character: 2, code: 6133, message: 'unused' }),
      ]},
      { path: '/proj/src/b.ts', source: 'typescript', diags: [
        diag({ line: 11, character: 2, code: 2304, message: 'cannot find name' }),
      ]},
    ]);
    const out = formatDiagnostics(m, '/proj/src/a.ts', '/proj');
    expect(out).toContain('<file_diagnostics>');
    expect(out).toContain('Error: src/a.ts:1:1 [typescript 2322] mismatch');
    expect(out).toContain('Warn: src/a.ts:6:3 [typescript 6133] unused');
    expect(out).toContain('</file_diagnostics>');
    expect(out).toContain('<project_diagnostics>');
    expect(out).toContain('Error: src/b.ts:12:3 [typescript 2304] cannot find name');
    expect(out).toContain('</project_diagnostics>');
    expect(out).toContain('<diagnostic_summary>');
    expect(out).toContain('Current file:  1 error, 1 warning');
    expect(out).toContain('Project:       1 error');
  });

  it('skips the file section when currentFile has no diagnostics', () => {
    const m = byUri([
      { path: '/proj/other.ts', source: 'typescript', diags: [diag({ message: 'x' })] },
    ]);
    const out = formatDiagnostics(m, '/proj/clean.ts', '/proj');
    expect(out).not.toContain('<file_diagnostics>');
    expect(out).toContain('<project_diagnostics>');
  });

  it('caps each section at 10 entries with "and N more" suffix', () => {
    const diags: Diagnostic[] = [];
    for (let i = 0; i < 15; i++) diags.push(diag({ line: i, code: 9999, message: `e${i}` }));
    const m = byUri([{ path: '/proj/big.ts', source: 'typescript', diags }]);
    const out = formatDiagnostics(m, '/proj/big.ts', '/proj');
    expect(out).toContain('... and 5 more diagnostics');
    // Should show the first 10 (sorted by line)
    expect(out).toContain('e0');
    expect(out).toContain('e9');
    // Should NOT show the 15th
    expect(out).not.toMatch(/^e14/m);
  });

  it('sorts errors before warnings before info', () => {
    const m = byUri([{ path: '/proj/a.ts', source: 'typescript', diags: [
      diag({ severity: DiagnosticSeverity.Information, line: 1, message: 'INFO' }),
      diag({ severity: DiagnosticSeverity.Warning,     line: 2, message: 'WARN' }),
      diag({ severity: DiagnosticSeverity.Error,       line: 3, message: 'ERR' }),
    ]}]);
    const out = formatDiagnostics(m, '/proj/a.ts', '/proj');
    const errIdx = out.indexOf('ERR');
    const warnIdx = out.indexOf('WARN');
    const infoIdx = out.indexOf('INFO');
    expect(errIdx).toBeLessThan(warnIdx);
    expect(warnIdx).toBeLessThan(infoIdx);
  });

  it('treats a project-wide query as all diagnostics in <project_diagnostics>', () => {
    const m = byUri([{ path: '/proj/a.ts', source: 'typescript', diags: [diag({ message: 'x' })] }]);
    const out = formatDiagnostics(m, undefined, '/proj');
    expect(out).not.toContain('<file_diagnostics>');
    expect(out).toContain('<project_diagnostics>');
  });

  it('skips entries with un-parseable URIs without crashing', () => {
    const m = new Map<string, { source: string; diagnostics: Diagnostic[] }>();
    m.set('not-a-uri://broken', { source: 'typescript', diagnostics: [diag({ message: 'should not appear' })] });
    m.set(pathToFileUri('/proj/a.ts'), { source: 'typescript', diagnostics: [diag({ message: 'real' })] });
    const out = formatDiagnostics(m, undefined, '/proj');
    expect(out).toContain('real');
    expect(out).not.toContain('should not appear');
  });
});
