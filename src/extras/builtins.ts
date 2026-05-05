import type { Extra } from './types.js';

/**
 * Built-in extras. Each one is small enough to keep all wiring readable in
 * this file. New languages/stacks should generally land here as a single
 * additional entry, not a new file — the registry is intentionally flat.
 */
export const BUILTIN_EXTRAS: Extra[] = [
  {
    name: 'typescript',
    description: 'TypeScript / JavaScript: typescript-language-server + prettier-on-save hint',
    projectMarkers: ['tsconfig.json', 'package.json'],
    lspRecipes: ['typescript'],
    postEditHooks: [
      {
        matcher: '^(edit_file|write_file|multi_edit)$',
        // Only formats when prettier is installed for the project. Quoted
        // braces inside $() so the shell expands the cwd, not vcode.
        command: 'command -v npx >/dev/null 2>&1 && [ -f "$VEEPEE_TOOL_ARGS_PATH" ] && case "$VEEPEE_TOOL_ARGS_PATH" in *.ts|*.tsx|*.js|*.jsx) npx --no prettier --write "$VEEPEE_TOOL_ARGS_PATH" 2>/dev/null || true ;; esac',
        description: 'Auto-prettier on TS/JS edits when prettier is available',
      },
    ],
    systemPromptSection: [
      '## TypeScript conventions',
      '',
      '- Match the existing tsconfig settings — read it before introducing new module-resolution or target conventions.',
      '- Prefer named exports over default exports unless the file already uses default.',
      '- Use `unknown` over `any`. Narrow with type guards.',
      '- Run `npx tsc --noEmit` to verify after edits when there is no LSP.',
    ].join('\n'),
  },
  {
    name: 'python',
    description: 'Python: pyright LSP + ruff-on-save hint',
    projectMarkers: ['pyproject.toml', 'setup.py', 'requirements.txt', 'Pipfile'],
    lspRecipes: ['python'],
    postEditHooks: [
      {
        matcher: '^(edit_file|write_file|multi_edit)$',
        command: 'command -v ruff >/dev/null 2>&1 && case "$VEEPEE_TOOL_ARGS_PATH" in *.py) ruff format "$VEEPEE_TOOL_ARGS_PATH" 2>/dev/null && ruff check --fix "$VEEPEE_TOOL_ARGS_PATH" 2>/dev/null || true ;; esac',
        description: 'Auto-ruff-format + auto-fix on .py edits when ruff is available',
      },
    ],
    systemPromptSection: [
      '## Python conventions',
      '',
      '- Prefer `pyproject.toml` over `setup.py` for new projects.',
      '- Use `pathlib.Path` over `os.path` for filesystem paths.',
      '- Type hints in new code: `from __future__ import annotations` at top, modern syntax (`list[int]`, `int | None`).',
      '- Run `python -m py_compile <file>` after edits when there is no LSP, or `ruff check` if ruff is configured.',
    ].join('\n'),
  },
  {
    name: 'go',
    description: 'Go: gopls LSP + gofmt-on-save hint',
    projectMarkers: ['go.mod', 'go.work'],
    lspRecipes: ['go'],
    postEditHooks: [
      {
        matcher: '^(edit_file|write_file|multi_edit)$',
        command: 'command -v gofmt >/dev/null 2>&1 && case "$VEEPEE_TOOL_ARGS_PATH" in *.go) gofmt -w "$VEEPEE_TOOL_ARGS_PATH" 2>/dev/null || true ;; esac',
        description: 'Auto-gofmt on .go edits',
      },
    ],
    systemPromptSection: [
      '## Go conventions',
      '',
      '- Run `go build ./...` and `go vet ./...` after edits to catch errors the LSP misses.',
      '- Errors are values: return them, do not panic for user-facing failures.',
      '- Prefer table-driven tests with subtests (`t.Run(name, func(t *testing.T) {...})`).',
    ].join('\n'),
  },
  {
    name: 'rust',
    description: 'Rust: rust-analyzer LSP + rustfmt-on-save hint',
    projectMarkers: ['Cargo.toml'],
    lspRecipes: ['rust'],
    postEditHooks: [
      {
        matcher: '^(edit_file|write_file|multi_edit)$',
        command: 'command -v rustfmt >/dev/null 2>&1 && case "$VEEPEE_TOOL_ARGS_PATH" in *.rs) rustfmt --edition 2021 "$VEEPEE_TOOL_ARGS_PATH" 2>/dev/null || true ;; esac',
        description: 'Auto-rustfmt on .rs edits',
      },
    ],
    systemPromptSection: [
      '## Rust conventions',
      '',
      '- Run `cargo check` after edits to catch type errors quickly; `cargo build` only when needed.',
      '- Use `Result<T, E>` and `?` over panics. Reach for `anyhow`/`thiserror` only when the error vocabulary justifies the dep.',
      '- Clippy lints are part of the bar: `cargo clippy --all-targets -- -D warnings`.',
    ].join('\n'),
  },
];

export function extraByName(name: string): Extra | null {
  return BUILTIN_EXTRAS.find((e) => e.name === name) ?? null;
}
