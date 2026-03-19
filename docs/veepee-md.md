---
title: "VEEPEE.md Project Instructions"
description: "Project instruction files: what to include, the /init command, hierarchical loading, and precedence rules."
weight: 13
---

# VEEPEE.md Project Instructions

VEEPEE.md is VEEPEE Code's equivalent of CLAUDE.md (Claude Code), AGENTS.md (Codex), GEMINI.md (Gemini CLI), or OpenCode.md. It is a markdown file containing project-specific instructions that are injected into every system prompt, ensuring the agent always has the right context about your project. Create one with the `/init` command.

## What Goes in VEEPEE.md

A well-written VEEPEE.md should be approximately 150 lines and contain:

### 1. Project Overview

What this project does, in 2-3 sentences.

```markdown
## Overview
A real-time dashboard for monitoring IoT sensor data. FastAPI backend,
React frontend, PostgreSQL for time-series storage. Deployed via Docker Compose.
```

### 2. Tech Stack

Language, framework, key libraries and dependencies.

```markdown
## Tech Stack
- Python 3.12 + FastAPI
- React 18 + TypeScript + Tailwind CSS 4
- PostgreSQL 17 with TimescaleDB extension
- Docker Compose for local dev and deployment
- pytest for backend, Vitest for frontend
```

### 3. Build / Lint / Test Commands

Exact commands. Especially include how to run a single test (critical for agent workflows).

```markdown
## Commands
- Build: `docker compose build`
- Start: `docker compose up -d`
- Backend tests: `docker compose exec api pytest`
- Single test: `docker compose exec api pytest tests/test_auth.py::test_login -xvs`
- Frontend tests: `cd frontend && npm test`
- Single frontend test: `cd frontend && npx vitest run src/hooks/useAuth.test.ts`
- Lint: `cd api && ruff check . && cd ../frontend && npm run lint`
- Type check: `cd frontend && npx tsc --noEmit`
```

### 4. Code Style Guidelines

Formatting, naming, import ordering, type usage. Infer from existing code -- do not guess.

```markdown
## Code Style
- Python: ruff format, 120 char lines, snake_case, type hints on all public functions
- TypeScript: Prettier (default), camelCase components, PascalCase types
- Imports: stdlib first, then third-party, then local (Python). External then internal (TS).
- Error handling: always use custom exception classes, never bare `except:`
- Database: use SQLAlchemy ORM, never raw SQL strings
```

### 5. Architecture Notes

Key directories, where to find what, important patterns.

```markdown
## Architecture
- `api/` -- FastAPI backend
  - `api/routes/` -- API endpoints (one file per resource)
  - `api/models/` -- SQLAlchemy models
  - `api/services/` -- Business logic (called by routes, never directly from models)
  - `api/schemas/` -- Pydantic request/response schemas
- `frontend/` -- React app (Vite)
  - `frontend/src/pages/` -- Route-level components
  - `frontend/src/components/` -- Reusable UI components
  - `frontend/src/hooks/` -- Custom React hooks
- `docker-compose.yml` -- All services (api, frontend, db, redis)
```

### 6. Common Gotchas

Things the agent might get wrong. These are the most valuable lines in the file.

```markdown
## Gotchas
- Always run `docker compose exec api alembic upgrade head` before tests
- This project uses pnpm, not npm. `pnpm install`, not `npm install`.
- Environment vars must be in BOTH `.env` and `docker-compose.yml` (Docker doesn't inherit .env automatically)
- The frontend proxy config is in `vite.config.ts`, not in an `.env` file
- Never import from `api/models/` in route files -- always go through `api/services/`
- The `created_at` column uses `func.now()` server-side default -- don't set it in Python
```

## The /init Command

The `/init` command analyzes your project and generates a VEEPEE.md using a hybrid approach:

```
/init
```

The command uses a two-phase process:

1. **Programmatic data gathering** -- VEEPEE Code itself (not the model) collects project context without any tool calls:
   - File tree structure
   - Package manifests (`package.json`, `pyproject.toml`, `Cargo.toml`, `requirements.txt`, etc.)
   - Config files (`.eslintrc`, `.prettierrc`, `tsconfig.json`, `ruff.toml`, `.editorconfig`)
   - README.md content
   - Sample source files to infer coding style
   - Existing instruction files (`.cursor/rules/`, `.cursorrules`, `.github/copilot-instructions.md`, `CLAUDE.md`, `AGENTS.md`, `OpenCode.md`, `GEMINI.md`)

2. **Model synthesis** -- The gathered data is sent to the model as a single prompt, asking it to synthesize a VEEPEE.md. The generated content is **streamed live to the TUI** so you can watch it being written.

After generation, VEEPEE Code writes the file directly (not via the model calling `write_file`) and updates `.gitignore` to include `VEEPEE.md` if the project is a git repo.

This hybrid approach is **much more reliable across different models** because it has no dependency on tool calling -- even models with poor function-calling support can generate good VEEPEE.md content since they only need to produce markdown.

If a VEEPEE.md already exists, `/init` reads it and improves it -- keeping what is good, adding what is missing, and fixing what is wrong.

## Hierarchical Loading

VEEPEE.md files are loaded from multiple locations and merged into the system prompt. Loading order (all are included if they exist):

### 1. Global (`~/.veepee-code/VEEPEE.md`)

Instructions that apply to all projects. Good for personal preferences:

```markdown
# Global Preferences

- Always use TypeScript strict mode
- Prefer functional programming patterns
- Never use `any` type -- use `unknown` and narrow
- Commit messages: conventional commits format
- Always add tests when creating new functions
```

### 2. Parent Directories (up to 5 levels)

Instructions from parent directories. Useful for monorepo or workspace-level rules:

```
~/workspace/my-org/VEEPEE.md       # Applies to all projects in the org
~/workspace/my-org/api/VEEPEE.md   # Applies to the API project
```

The loader walks up from the current directory, checking each parent for a VEEPEE.md file, up to 5 levels.

### 3. Workspace (`./VEEPEE.md`)

Instructions in the current working directory. Highest precedence.

## Precedence Rules

All found VEEPEE.md files are included in the system prompt, with precedence noted:

```
## Project Instructions (VEEPEE.md)

The following instructions are loaded from VEEPEE.md files. These are foundational
mandates from the user.
**Precedence:** Workspace > Parent > Global. These instructions override default
behaviors but cannot override safety rules.

### Source: global (~/.veepee-code/VEEPEE.md)
(global content here)

### Source: parent (../../VEEPEE.md)
(parent content here)

### Source: workspace (VEEPEE.md)
(workspace content here)
```

The model is instructed that:
- **Workspace instructions override parent and global** when there are conflicts
- **All instructions override default behaviors** (e.g., if VEEPEE.md says "always use tabs", the agent uses tabs even if its default preference is spaces)
- **Safety rules cannot be overridden** -- VEEPEE.md cannot instruct the agent to skip permission checks or ignore destructive operation warnings

## Best Practices

1. **Be specific and actionable.** "Use ESM imports" is better than "Follow modern JavaScript practices."

2. **Include the exact commands.** "Run tests with `pytest tests/ -x --tb=short`" is better than "Use pytest for testing."

3. **Document the non-obvious.** Everyone knows to run `npm install`. Document that the project needs `npm run generate` before `npm run dev` because it generates GraphQL types.

4. **Keep it under 200 lines.** Long VEEPEE.md files waste context tokens. Focus on what the agent needs to know, not what a human README reader needs.

5. **Update it.** Run `/init` periodically as your project evolves. The agent will update the file while preserving good content.

6. **Add it to .gitignore.** VEEPEE.md may contain information about your local setup that is not relevant to other contributors. The `/init` command does this automatically.

## Example VEEPEE.md

```markdown
# Project: VEEPEE Code

## Overview
AI coding CLI powered by local Ollama models. TypeScript, full-screen TUI, 25 tools.

## Stack
- TypeScript 5.8, Node.js 22
- Ollama JS SDK, Zod, chalk, marked, glob
- Build: `tsc` (ESM output to dist/)

## Commands
- Dev: `npx tsx src/index.ts`
- Build: `npm run build`
- Start: `node dist/index.js`

## Code Style
- ESM imports with `.js` extensions (TypeScript ESM requirement)
- Functional style: prefer `async function` over class methods where possible
- Zod for all tool parameter validation
- All tools return `ToolResult` via `ok()` or `fail()` helpers
- Error messages should be actionable: tell the user what to do, not just what failed

## Architecture
- `src/index.ts` -- Entry point, main loop, command handling
- `src/agent.ts` -- ReAct agent loop, model switching, mode management
- `src/models.ts` -- Model discovery, ranking, auto-switching
- `src/context.ts` -- System prompt builder, context manager, VEEPEE.md loader
- `src/permissions.ts` -- Permission system
- `src/tools/` -- Tool definitions by category
- `src/tui/` -- Terminal UI (screen, theme, logo, input handling)

## Gotchas
- ESM requires `.js` extensions in imports even though source is `.ts`
- The Ollama SDK types don't always match -- use `as never` for streaming options
- Tool schemas use Zod but are converted to JSON Schema for the Ollama API
- Context compaction drops middle messages, keeping first + last 10
- The TUI uses alternate screen buffer -- stdout.write escape codes, not console.log
```
