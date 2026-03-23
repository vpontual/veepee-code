import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { detectProject, formatProjectInfo, getCodingGuidance } from '../src/detect.js';
import type { ProjectInfo } from '../src/detect.js';

// Helper: create a temp directory for each test
let tempDir: string;

function setup(): string {
  tempDir = mkdtempSync(join(tmpdir(), 'detect-test-'));
  return tempDir;
}

function touch(name: string, content = '') {
  const fullPath = join(tempDir, name);
  const dir = fullPath.substring(0, fullPath.lastIndexOf('/'));
  if (dir !== tempDir) mkdirSync(dir, { recursive: true });
  writeFileSync(fullPath, content);
}

function writePkg(deps: Record<string, string> = {}, devDeps: Record<string, string> = {}) {
  touch('package.json', JSON.stringify({
    name: 'test-project',
    dependencies: deps,
    devDependencies: devDeps,
  }));
}

describe('detectProject', () => {
  beforeEach(() => setup());
  afterEach(() => rmSync(tempDir, { recursive: true, force: true }));

  // ── Empty directory ─────────────────────────────────────────────

  it('returns all nulls/false for an empty directory', () => {
    const info = detectProject(tempDir);
    expect(info.language).toBeNull();
    expect(info.framework).toBeNull();
    expect(info.packageManager).toBeNull();
    expect(info.testRunner).toBeNull();
    expect(info.hasLinter).toBe(false);
    expect(info.hasCi).toBe(false);
    expect(info.monorepo).toBe(false);
  });

  // ── Language detection ──────────────────────────────────────────

  it('detects TypeScript via tsconfig.json', () => {
    touch('tsconfig.json', '{}');
    expect(detectProject(tempDir).language).toBe('TypeScript');
  });

  it('detects JavaScript via package.json (no tsconfig)', () => {
    writePkg();
    expect(detectProject(tempDir).language).toBe('JavaScript');
  });

  it('detects JavaScript via jsconfig.json', () => {
    touch('jsconfig.json', '{}');
    expect(detectProject(tempDir).language).toBe('JavaScript');
  });

  it('detects Python via pyproject.toml', () => {
    touch('pyproject.toml', '[project]\nname = "foo"');
    expect(detectProject(tempDir).language).toBe('Python');
  });

  it('detects Python via requirements.txt', () => {
    touch('requirements.txt', 'requests\n');
    expect(detectProject(tempDir).language).toBe('Python');
  });

  it('detects Python via setup.py', () => {
    touch('setup.py', 'from setuptools import setup');
    expect(detectProject(tempDir).language).toBe('Python');
  });

  it('detects Rust via Cargo.toml', () => {
    touch('Cargo.toml', '[package]');
    expect(detectProject(tempDir).language).toBe('Rust');
  });

  it('detects Go via go.mod', () => {
    touch('go.mod', 'module example.com/foo');
    expect(detectProject(tempDir).language).toBe('Go');
  });

  it('detects Ruby via Gemfile', () => {
    touch('Gemfile', "source 'https://rubygems.org'");
    expect(detectProject(tempDir).language).toBe('Ruby');
  });

  // ── Polyglot: first match wins (else-if chain) ─────────────────

  it('TypeScript wins over Python when both tsconfig.json and pyproject.toml exist', () => {
    touch('tsconfig.json', '{}');
    touch('pyproject.toml', '[project]');
    expect(detectProject(tempDir).language).toBe('TypeScript');
  });

  it('TypeScript wins over JavaScript when tsconfig.json and package.json both exist', () => {
    touch('tsconfig.json', '{}');
    writePkg();
    expect(detectProject(tempDir).language).toBe('TypeScript');
  });

  // ── Package manager detection ───────────────────────────────────

  it('detects bun via bun.lockb', () => {
    touch('bun.lockb');
    expect(detectProject(tempDir).packageManager).toBe('bun');
  });

  it('detects bun via bun.lock', () => {
    touch('bun.lock');
    expect(detectProject(tempDir).packageManager).toBe('bun');
  });

  it('detects pnpm via pnpm-lock.yaml', () => {
    touch('pnpm-lock.yaml');
    expect(detectProject(tempDir).packageManager).toBe('pnpm');
  });

  it('detects yarn via yarn.lock', () => {
    touch('yarn.lock');
    expect(detectProject(tempDir).packageManager).toBe('yarn');
  });

  it('detects npm via package-lock.json', () => {
    touch('package-lock.json', '{}');
    expect(detectProject(tempDir).packageManager).toBe('npm');
  });

  it('detects cargo via Cargo.lock', () => {
    touch('Cargo.lock');
    expect(detectProject(tempDir).packageManager).toBe('cargo');
  });

  it('detects go modules via go.sum', () => {
    touch('go.sum');
    expect(detectProject(tempDir).packageManager).toBe('go modules');
  });

  it('detects bundler via Gemfile.lock', () => {
    touch('Gemfile.lock');
    expect(detectProject(tempDir).packageManager).toBe('bundler');
  });

  it('detects poetry via poetry.lock', () => {
    touch('poetry.lock');
    expect(detectProject(tempDir).packageManager).toBe('poetry');
  });

  it('detects uv via uv.lock', () => {
    touch('uv.lock');
    expect(detectProject(tempDir).packageManager).toBe('uv');
  });

  it('detects pip via requirements.txt', () => {
    touch('requirements.txt', 'requests\n');
    expect(detectProject(tempDir).packageManager).toBe('pip');
  });

  it('detects pip via pyproject.toml (no poetry/uv lock)', () => {
    touch('pyproject.toml', '[project]');
    expect(detectProject(tempDir).packageManager).toBe('pip');
  });

  it('package manager priority: bun > pnpm', () => {
    touch('bun.lockb');
    touch('pnpm-lock.yaml');
    expect(detectProject(tempDir).packageManager).toBe('bun');
  });

  it('package manager priority: pnpm > yarn', () => {
    touch('pnpm-lock.yaml');
    touch('yarn.lock');
    expect(detectProject(tempDir).packageManager).toBe('pnpm');
  });

  // ── Framework detection (JS) ────────────────────────────────────

  it('detects Next.js from package.json dependencies', () => {
    writePkg({ next: '^14.2.0', react: '^18.0.0' });
    expect(detectProject(tempDir).framework).toBe('Next.js 14.2.0');
  });

  it('detects Astro from package.json devDependencies', () => {
    writePkg({}, { astro: '^4.5.0' });
    expect(detectProject(tempDir).framework).toBe('Astro 4.5.0');
  });

  it('detects Nuxt from package.json', () => {
    writePkg({ nuxt: '^3.0.0' });
    expect(detectProject(tempDir).framework).toBe('Nuxt 3.0.0');
  });

  it('detects SvelteKit from package.json', () => {
    writePkg({ svelte: '^4.0.0' });
    expect(detectProject(tempDir).framework).toBe('SvelteKit');
  });

  it('detects Vite standalone (no higher-level framework)', () => {
    writePkg({}, { vite: '^5.0.0' });
    expect(detectProject(tempDir).framework).toBe('Vite');
  });

  it('detects React standalone', () => {
    writePkg({ react: '^18.0.0' });
    expect(detectProject(tempDir).framework).toBe('React');
  });

  it('detects Vue standalone', () => {
    writePkg({ vue: '^3.0.0' });
    expect(detectProject(tempDir).framework).toBe('Vue');
  });

  it('detects Express', () => {
    writePkg({ express: '^4.18.0' });
    expect(detectProject(tempDir).framework).toBe('Express');
  });

  it('detects Fastify', () => {
    writePkg({ fastify: '^4.0.0' });
    expect(detectProject(tempDir).framework).toBe('Fastify');
  });

  it('detects Hono', () => {
    writePkg({ hono: '^4.0.0' });
    expect(detectProject(tempDir).framework).toBe('Hono');
  });

  it('Next.js wins over React (else-if chain)', () => {
    writePkg({ next: '^14.0.0', react: '^18.0.0' });
    expect(detectProject(tempDir).framework).toBe('Next.js 14.0.0');
  });

  // ── Framework detection (Ruby) ──────────────────────────────────

  it('detects Rails from Gemfile', () => {
    touch('Gemfile', "gem 'rails', '~> 7.0'");
    expect(detectProject(tempDir).framework).toBe('Rails');
  });

  it('does not detect Rails when Gemfile has no rails gem', () => {
    touch('Gemfile', "gem 'sinatra'");
    expect(detectProject(tempDir).framework).toBeNull();
  });

  // ── Framework detection (Python) ────────────────────────────────

  it('detects FastAPI from requirements.txt', () => {
    touch('requirements.txt', 'fastapi\nuvicorn\n');
    expect(detectProject(tempDir).framework).toBe('FastAPI');
  });

  it('detects Django from requirements.txt', () => {
    touch('requirements.txt', 'django>=4.0\n');
    expect(detectProject(tempDir).framework).toBe('Django');
  });

  it('detects Flask from requirements.txt', () => {
    touch('requirements.txt', 'flask\n');
    expect(detectProject(tempDir).framework).toBe('Flask');
  });

  // ── Test runner detection ───────────────────────────────────────

  it('detects vitest from package.json devDependencies', () => {
    writePkg({}, { vitest: '^1.0.0' });
    expect(detectProject(tempDir).testRunner).toBe('vitest');
  });

  it('detects jest from package.json dependencies', () => {
    writePkg({}, { jest: '^29.0.0' });
    expect(detectProject(tempDir).testRunner).toBe('jest');
  });

  it('detects mocha from package.json', () => {
    writePkg({}, { mocha: '^10.0.0' });
    expect(detectProject(tempDir).testRunner).toBe('mocha');
  });

  it('detects pytest from pyproject.toml containing [tool.pytest]', () => {
    touch('pyproject.toml', '[tool.pytest]\ntestpaths = ["tests"]');
    expect(detectProject(tempDir).testRunner).toBe('pytest');
  });

  it('detects pytest from pyproject.toml containing pytest keyword', () => {
    touch('pyproject.toml', '[project]\ndependencies = ["pytest"]');
    expect(detectProject(tempDir).testRunner).toBe('pytest');
  });

  it('detects go test from go.mod', () => {
    touch('go.mod', 'module example.com/foo');
    expect(detectProject(tempDir).testRunner).toBe('go test');
  });

  it('detects cargo test from Cargo.toml', () => {
    touch('Cargo.toml', '[package]');
    expect(detectProject(tempDir).testRunner).toBe('cargo test');
  });

  // ── Linter detection ────────────────────────────────────────────

  it('detects eslint via .eslintrc.json', () => {
    touch('.eslintrc.json', '{}');
    expect(detectProject(tempDir).hasLinter).toBe(true);
  });

  it('detects eslint via eslint.config.js', () => {
    touch('eslint.config.js', 'export default {};');
    expect(detectProject(tempDir).hasLinter).toBe(true);
  });

  it('detects eslint via eslint.config.mjs', () => {
    touch('eslint.config.mjs', 'export default {};');
    expect(detectProject(tempDir).hasLinter).toBe(true);
  });

  it('detects biome via biome.json', () => {
    touch('biome.json', '{}');
    expect(detectProject(tempDir).hasLinter).toBe(true);
  });

  it('detects prettier via .prettierrc', () => {
    touch('.prettierrc', '{}');
    expect(detectProject(tempDir).hasLinter).toBe(true);
  });

  it('detects ruff via ruff.toml', () => {
    touch('ruff.toml', '');
    expect(detectProject(tempDir).hasLinter).toBe(true);
  });

  it('detects rubocop via .rubocop.yml', () => {
    touch('.rubocop.yml', '');
    expect(detectProject(tempDir).hasLinter).toBe(true);
  });

  it('detects golangci via .golangci.yml', () => {
    touch('.golangci.yml', '');
    expect(detectProject(tempDir).hasLinter).toBe(true);
  });

  it('hasLinter is false when no linter config exists', () => {
    writePkg();
    expect(detectProject(tempDir).hasLinter).toBe(false);
  });

  // ── CI detection ────────────────────────────────────────────────

  it('detects CI via .github/workflows directory', () => {
    mkdirSync(join(tempDir, '.github', 'workflows'), { recursive: true });
    expect(detectProject(tempDir).hasCi).toBe(true);
  });

  it('detects CI via .gitlab-ci.yml', () => {
    touch('.gitlab-ci.yml', '');
    expect(detectProject(tempDir).hasCi).toBe(true);
  });

  it('detects CI via .circleci directory', () => {
    mkdirSync(join(tempDir, '.circleci'), { recursive: true });
    expect(detectProject(tempDir).hasCi).toBe(true);
  });

  it('hasCi is false when no CI config exists', () => {
    writePkg();
    expect(detectProject(tempDir).hasCi).toBe(false);
  });

  // ── Monorepo detection ──────────────────────────────────────────

  it('detects monorepo via pnpm-workspace.yaml', () => {
    touch('pnpm-workspace.yaml', '');
    expect(detectProject(tempDir).monorepo).toBe(true);
  });

  it('detects monorepo via lerna.json', () => {
    touch('lerna.json', '{}');
    expect(detectProject(tempDir).monorepo).toBe(true);
  });

  it('detects monorepo via nx.json', () => {
    touch('nx.json', '{}');
    expect(detectProject(tempDir).monorepo).toBe(true);
  });

  it('detects monorepo via turbo.json', () => {
    touch('turbo.json', '{}');
    expect(detectProject(tempDir).monorepo).toBe(true);
  });

  it('monorepo is false when no monorepo config exists', () => {
    writePkg();
    expect(detectProject(tempDir).monorepo).toBe(false);
  });

  // ── Full integration: realistic project ─────────────────────────

  it('detects a full Next.js + TypeScript project', () => {
    touch('tsconfig.json', '{}');
    touch('pnpm-lock.yaml');
    touch('eslint.config.mjs', '');
    mkdirSync(join(tempDir, '.github', 'workflows'), { recursive: true });
    writePkg({ next: '^14.2.0', react: '^18.0.0' }, { vitest: '^1.0.0', typescript: '^5.0.0' });

    const info = detectProject(tempDir);
    expect(info.language).toBe('TypeScript');
    expect(info.framework).toBe('Next.js 14.2.0');
    expect(info.packageManager).toBe('pnpm');
    expect(info.testRunner).toBe('vitest');
    expect(info.hasLinter).toBe(true);
    expect(info.hasCi).toBe(true);
  });

  it('detects a Python FastAPI project', () => {
    touch('requirements.txt', 'fastapi\nuvicorn\npydantic\n');
    touch('pyproject.toml', '[tool.pytest]\ntestpaths = ["tests"]');
    touch('ruff.toml', '');

    const info = detectProject(tempDir);
    expect(info.language).toBe('Python');
    expect(info.framework).toBe('FastAPI');
    expect(info.packageManager).toBe('pip');
    expect(info.testRunner).toBe('pytest');
    expect(info.hasLinter).toBe(true);
  });
});

// ── formatProjectInfo ────────────────────────────────────────────

describe('formatProjectInfo', () => {
  it('returns empty string when all fields are null/false', () => {
    const info: ProjectInfo = {
      language: null,
      framework: null,
      packageManager: null,
      testRunner: null,
      hasLinter: false,
      hasCi: false,
      monorepo: false,
    };
    expect(formatProjectInfo(info)).toBe('');
  });

  it('formats a full project info with pipe delimiters', () => {
    const info: ProjectInfo = {
      language: 'TypeScript',
      framework: 'Next.js 14.2.0',
      packageManager: 'pnpm',
      testRunner: 'vitest',
      hasLinter: true,
      hasCi: true,
      monorepo: false,
    };
    const result = formatProjectInfo(info);
    expect(result).toBe('Language: TypeScript | Framework: Next.js 14.2.0 | Package manager: pnpm | Test runner: vitest | Linter: configured | CI: configured');
  });

  it('includes monorepo when true', () => {
    const info: ProjectInfo = {
      language: 'TypeScript',
      framework: null,
      packageManager: 'pnpm',
      testRunner: null,
      hasLinter: false,
      hasCi: false,
      monorepo: true,
    };
    const result = formatProjectInfo(info);
    expect(result).toContain('Monorepo: yes');
  });

  it('only includes non-null/true fields', () => {
    const info: ProjectInfo = {
      language: 'Python',
      framework: null,
      packageManager: 'pip',
      testRunner: null,
      hasLinter: false,
      hasCi: false,
      monorepo: false,
    };
    const result = formatProjectInfo(info);
    expect(result).toBe('Language: Python | Package manager: pip');
  });
});

// ── getCodingGuidance ────────────────────────────────────────────

describe('getCodingGuidance', () => {
  function makeInfo(overrides: Partial<ProjectInfo> = {}): ProjectInfo {
    return {
      language: null,
      framework: null,
      packageManager: null,
      testRunner: null,
      hasLinter: false,
      hasCi: false,
      monorepo: false,
      ...overrides,
    };
  }

  it('returns empty string when nothing is set', () => {
    expect(getCodingGuidance(makeInfo())).toBe('');
  });

  // Language guidance

  it('includes TypeScript guidance for TypeScript projects', () => {
    const result = getCodingGuidance(makeInfo({ language: 'TypeScript' }));
    expect(result).toContain('import`/`export');
    expect(result).toContain('interface');
    expect(result).toContain('tsc --noEmit');
  });

  it('includes Python guidance for Python projects', () => {
    const result = getCodingGuidance(makeInfo({ language: 'Python' }));
    expect(result).toContain('type hints');
    expect(result).toContain('pathlib');
  });

  it('includes Go guidance for Go projects', () => {
    const result = getCodingGuidance(makeInfo({ language: 'Go' }));
    expect(result).toContain('go vet');
    expect(result).toContain('go fmt');
  });

  it('includes Rust guidance for Rust projects', () => {
    const result = getCodingGuidance(makeInfo({ language: 'Rust' }));
    expect(result).toContain('cargo check');
    expect(result).toContain('Result');
  });

  // Framework guidance

  it('includes Next.js guidance', () => {
    const result = getCodingGuidance(makeInfo({ framework: 'Next.js 14.2.0' }));
    expect(result).toContain('App Router');
    expect(result).toContain('use client');
  });

  it('includes Astro guidance', () => {
    const result = getCodingGuidance(makeInfo({ framework: 'Astro 4.5.0' }));
    expect(result).toContain('.astro');
    expect(result).toContain('frontmatter');
  });

  it('includes FastAPI guidance', () => {
    const result = getCodingGuidance(makeInfo({ framework: 'FastAPI' }));
    expect(result).toContain('Pydantic');
    expect(result).toContain('Depends()');
  });

  it('includes Rails guidance', () => {
    const result = getCodingGuidance(makeInfo({ framework: 'Rails' }));
    expect(result).toContain('Rails conventions');
    expect(result).toContain('bin/rails test');
  });

  // Package manager guidance

  it('includes pnpm guidance', () => {
    const result = getCodingGuidance(makeInfo({ packageManager: 'pnpm' }));
    expect(result).toContain('pnpm add');
    expect(result).toContain('pnpm dlx');
  });

  it('includes bun guidance', () => {
    const result = getCodingGuidance(makeInfo({ packageManager: 'bun' }));
    expect(result).toContain('bun add');
    expect(result).toContain('bunx');
  });

  // Test runner guidance

  it('includes vitest guidance', () => {
    const result = getCodingGuidance(makeInfo({ testRunner: 'vitest' }));
    expect(result).toContain('vitest run');
  });

  it('includes jest guidance', () => {
    const result = getCodingGuidance(makeInfo({ testRunner: 'jest' }));
    expect(result).toContain('npx jest');
  });

  it('includes pytest guidance', () => {
    const result = getCodingGuidance(makeInfo({ testRunner: 'pytest' }));
    expect(result).toContain('conftest.py');
  });

  // Linter guidance

  it('includes linter guidance when hasLinter is true', () => {
    const result = getCodingGuidance(makeInfo({ hasLinter: true }));
    expect(result).toContain('linter is configured');
  });

  it('does not include linter guidance when hasLinter is false', () => {
    const result = getCodingGuidance(makeInfo({ hasLinter: false }));
    expect(result).not.toContain('linter');
  });

  // Combined guidance

  it('combines multiple guidance sections', () => {
    const result = getCodingGuidance(makeInfo({
      language: 'TypeScript',
      framework: 'Next.js 14.0.0',
      packageManager: 'pnpm',
      testRunner: 'vitest',
      hasLinter: true,
    }));
    expect(result).toContain('## Project-Specific Guidance');
    expect(result).toContain('import`/`export');
    expect(result).toContain('App Router');
    expect(result).toContain('pnpm add');
    expect(result).toContain('vitest run');
    expect(result).toContain('linter is configured');
  });
});
