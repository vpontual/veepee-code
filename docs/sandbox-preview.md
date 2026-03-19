---
title: "Sandbox & Preview"
description: "Per-session scratch directory, script execution, and HTML preview server."
weight: 16
---

# Sandbox & Preview

VEEPEE Code v0.3.0 introduces a sandbox for scratch files and a preview system for inline script execution and HTML serving.

## Sandbox

### What It Does

Each session gets its own sandbox directory at `~/.veepee-code/sandbox/{sessionId}/`. The AI can write temporary files here instead of polluting your workspace. Files are auto-cleaned when the session ends.

The sandbox path is injected into the system prompt so the model knows about it. The model decides where to write based on the system prompt — sandbox is opt-in and transparent (the `write_file` tool is NOT auto-redirected).

### Commands

```
/sandbox                        # List sandbox files with sizes
/sandbox keep <file> [dest]     # Move file to cwd (or custom destination)
/sandbox clean                  # Remove all sandbox files
/sandbox preview <file>         # Preview a sandbox file
```

### Auto-Cleanup

- **On session end:** If the sandbox has files, they are listed and removed automatically.
- **On startup:** Sandbox directories older than 24 hours are cleaned up (handles abandoned sessions).

### Example Workflow

```
> Write a quick Python script to parse the CSV and show stats

  ◆ write_file path=~/.veepee-code/sandbox/abc123/parse_csv.py content="..."
  ✓ Written

/sandbox
  parse_csv.py                    1.2KB

/run sandbox:parse_csv.py
  Total rows: 1,234
  Average value: 42.7
  Max: 99, Min: 1

/sandbox keep parse_csv.py src/utils/parse_csv.py
  Kept: parse_csv.py → /Users/vp/project/src/utils/parse_csv.py
```

## Preview / Run

### What It Does

`/preview` and `/run` execute scripts inline or serve HTML files in the browser. They are aliases — both use the same underlying system.

### Supported File Types

| Extension | Runner | Timeout |
|-----------|--------|---------|
| `.py` | `python3` | 30s |
| `.sh` | `bash` | 30s |
| `.js` | `node` | 30s |
| `.mjs` | `node` | 30s |
| `.ts` | `npx tsx` | 30s |
| `.rb` | `ruby` | 30s |
| `.pl` | `perl` | 30s |
| `.lua` | `lua` | 30s |
| `.html` / `.htm` | Static file server + browser open | — |

### Commands

```
/preview <file>           # Preview/run a file
/run <file>               # Alias for /preview
/preview sandbox:test.py  # Run a sandbox file (sandbox: prefix)
/preview stop             # Stop the static file server
```

### HTML Preview

For HTML files, VEEPEE Code starts a static file server in the file's directory:

- **Port:** Auto-picks from 8485+ (increments if in use)
- **MIME types:** Supports HTML, CSS, JS, JSON, images (PNG, JPG, GIF, SVG), fonts, media, and more
- **Security:** Directory traversal prevention
- **Browser:** Opens automatically (`open` on macOS, `xdg-open` on Linux)

The server stays running until `/preview stop` or session end. It serves all files in the directory, so multi-file HTML projects work out of the box.

### Script Execution

Scripts run in a child process with:
- Working directory set to the script's directory
- 30-second timeout
- stdout and stderr captured
- Non-zero exit codes shown in output

### Sandbox Integration

Use the `sandbox:` prefix to resolve paths relative to the sandbox:

```
/run sandbox:calculator.py    # Runs ~/.veepee-code/sandbox/{id}/calculator.py
/preview sandbox:index.html   # Serves the sandbox directory
```

Or use `/sandbox preview <file>` as a shortcut.
