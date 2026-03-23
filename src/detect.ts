import { existsSync, readFileSync } from 'fs';
import { join, basename } from 'path';
import { readdirSync } from 'fs';

export interface ProjectInfo {
  language: string | null;         // TypeScript, Python, Go, Rust, Ruby, etc.
  framework: string | null;        // Next.js, Astro, Vite, FastAPI, Rails, etc.
  packageManager: string | null;   // npm, pnpm, yarn, bun, pip, cargo, etc.
  testRunner: string | null;       // vitest, jest, pytest, go test, etc.
  hasLinter: boolean;
  hasCi: boolean;
  monorepo: boolean;
}

export function detectProject(cwd: string): ProjectInfo {
  const info: ProjectInfo = {
    language: null,
    framework: null,
    packageManager: null,
    testRunner: null,
    hasLinter: false,
    hasCi: false,
    monorepo: false,
  };

  const has = (name: string) => existsSync(join(cwd, name));
  const readJson = (name: string): Record<string, unknown> | null => {
    try { return JSON.parse(readFileSync(join(cwd, name), 'utf-8')); } catch { return null; }
  };

  // ─── Package Manager ──────────────────────────────────────────────

  if (has('bun.lockb') || has('bun.lock')) info.packageManager = 'bun';
  else if (has('pnpm-lock.yaml')) info.packageManager = 'pnpm';
  else if (has('yarn.lock')) info.packageManager = 'yarn';
  else if (has('package-lock.json')) info.packageManager = 'npm';
  else if (has('Cargo.lock')) info.packageManager = 'cargo';
  else if (has('go.sum')) info.packageManager = 'go modules';
  else if (has('Gemfile.lock')) info.packageManager = 'bundler';
  else if (has('poetry.lock')) info.packageManager = 'poetry';
  else if (has('uv.lock')) info.packageManager = 'uv';
  else if (has('requirements.txt') || has('pyproject.toml')) info.packageManager = 'pip';

  // ─── Language ─────────────────────────────────────────────────────

  if (has('tsconfig.json')) info.language = 'TypeScript';
  else if (has('jsconfig.json') || has('package.json')) info.language = 'JavaScript';
  if (has('pyproject.toml') || has('setup.py') || has('requirements.txt')) info.language = 'Python';
  if (has('Cargo.toml')) info.language = 'Rust';
  if (has('go.mod')) info.language = 'Go';
  if (has('Gemfile')) info.language = 'Ruby';

  // ─── Framework ────────────────────────────────────────────────────

  const pkg = readJson('package.json') as { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; scripts?: Record<string, string> } | null;
  const allDeps = { ...pkg?.dependencies, ...pkg?.devDependencies };

  if (allDeps) {
    if (allDeps['next']) info.framework = `Next.js ${allDeps['next'].replace('^', '')}`;
    else if (allDeps['astro']) info.framework = `Astro ${allDeps['astro'].replace('^', '')}`;
    else if (allDeps['nuxt']) info.framework = `Nuxt ${allDeps['nuxt'].replace('^', '')}`;
    else if (allDeps['svelte']) info.framework = 'SvelteKit';
    else if (allDeps['vite'] && !info.framework) info.framework = 'Vite';
    else if (allDeps['react'] && !info.framework) info.framework = 'React';
    else if (allDeps['vue'] && !info.framework) info.framework = 'Vue';
    else if (allDeps['express']) info.framework = 'Express';
    else if (allDeps['fastify']) info.framework = 'Fastify';
    else if (allDeps['hono']) info.framework = 'Hono';
  }

  if (has('Gemfile')) {
    try {
      const gemfile = readFileSync(join(cwd, 'Gemfile'), 'utf-8');
      if (gemfile.includes("'rails'") || gemfile.includes('"rails"')) info.framework = 'Rails';
    } catch {}
  }

  const pyproject = readJson('pyproject.toml');
  if (has('requirements.txt')) {
    try {
      const reqs = readFileSync(join(cwd, 'requirements.txt'), 'utf-8');
      if (reqs.includes('fastapi')) info.framework = 'FastAPI';
      else if (reqs.includes('django')) info.framework = 'Django';
      else if (reqs.includes('flask')) info.framework = 'Flask';
    } catch {}
  }

  // ─── Test Runner ──────────────────────────────────────────────────

  if (allDeps) {
    if (allDeps['vitest']) info.testRunner = 'vitest';
    else if (allDeps['jest']) info.testRunner = 'jest';
    else if (allDeps['mocha']) info.testRunner = 'mocha';
  }
  if (has('pytest.ini') || has('conftest.py') || has('pyproject.toml')) {
    try {
      const pyproj = readFileSync(join(cwd, 'pyproject.toml'), 'utf-8');
      if (pyproj.includes('[tool.pytest]') || pyproj.includes('pytest')) info.testRunner = 'pytest';
    } catch {}
  }
  if (has('go.mod')) info.testRunner = 'go test';
  if (has('Cargo.toml')) info.testRunner = 'cargo test';

  // ─── Linter & CI ──────────────────────────────────────────────────

  info.hasLinter = has('.eslintrc.json') || has('.eslintrc.js') || has('eslint.config.js') ||
    has('eslint.config.mjs') || has('biome.json') || has('.prettierrc') ||
    has('ruff.toml') || has('.rubocop.yml') || has('.golangci.yml');
  info.hasCi = has('.github/workflows') || has('.gitlab-ci.yml') || has('.circleci');

  // ─── Monorepo ─────────────────────────────────────────────────────

  info.monorepo = has('pnpm-workspace.yaml') || has('lerna.json') ||
    has('nx.json') || has('turbo.json');

  return info;
}

export function formatProjectInfo(info: ProjectInfo): string {
  const parts: string[] = [];
  if (info.language) parts.push(`Language: ${info.language}`);
  if (info.framework) parts.push(`Framework: ${info.framework}`);
  if (info.packageManager) parts.push(`Package manager: ${info.packageManager}`);
  if (info.testRunner) parts.push(`Test runner: ${info.testRunner}`);
  if (info.hasLinter) parts.push(`Linter: configured`);
  if (info.hasCi) parts.push(`CI: configured`);
  if (info.monorepo) parts.push(`Monorepo: yes`);
  return parts.length > 0 ? parts.join(' | ') : '';
}

export function getCodingGuidance(info: ProjectInfo): string {
  const lines: string[] = [];

  // Language-specific
  if (info.language === 'TypeScript') {
    lines.push('- Use `import`/`export`, not `require`. Check tsconfig.json for path aliases and strict mode.');
    lines.push('- Prefer `interface` for object shapes, `type` for unions/intersections.');
    lines.push('- After editing, verify with: `npx tsc --noEmit`');
  }
  if (info.language === 'Python') {
    lines.push('- Use type hints on function signatures. Use `pathlib` over `os.path`.');
    lines.push('- Check for pyproject.toml before adding dependencies.');
  }
  if (info.language === 'Go') {
    lines.push('- Run `go vet` and `go fmt` after changes. Check error returns — never ignore them.');
  }
  if (info.language === 'Rust') {
    lines.push('- Run `cargo check` after changes. Prefer `Result` over `unwrap()` in library code.');
  }

  // Framework-specific
  if (info.framework?.startsWith('Next.js')) {
    lines.push('- Check if using App Router (app/) or Pages Router (pages/). Do NOT mix them.');
    lines.push('- Server components are default in App Router. Add "use client" only when needed.');
  }
  if (info.framework?.startsWith('Astro')) {
    lines.push('- Components are `.astro` files with frontmatter (---). Use framework integrations for React/Vue.');
  }
  if (info.framework === 'FastAPI') {
    lines.push('- Use Pydantic models for request/response validation. Use `Depends()` for dependency injection.');
  }
  if (info.framework === 'Rails') {
    lines.push('- Follow Rails conventions. Use generators when appropriate. Run `bin/rails test` after changes.');
  }

  // Package manager
  if (info.packageManager === 'pnpm') {
    lines.push('- Use `pnpm add` not `npm install`. Use `pnpm dlx` not `npx`.');
  }
  if (info.packageManager === 'bun') {
    lines.push('- Use `bun add` not `npm install`. Use `bunx` not `npx`.');
  }

  // Test runner
  if (info.testRunner === 'vitest') {
    lines.push('- Run tests with `npx vitest run`. Check vitest.config.ts for setup.');
  }
  if (info.testRunner === 'jest') {
    lines.push('- Run tests with `npx jest`. Check jest.config for module aliases.');
  }
  if (info.testRunner === 'pytest') {
    lines.push('- Run tests with `pytest`. Check conftest.py for fixtures.');
  }

  // Verification
  if (info.hasLinter) {
    lines.push('- A linter is configured. Run it after changes to catch style issues.');
  }

  if (lines.length === 0) return '';

  return '\n## Project-Specific Guidance\n\n' + lines.join('\n');
}
