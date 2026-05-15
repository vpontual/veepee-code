#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "--installed" ]]; then
  cmd=(/home/vp/.local/bin/vcode acp)
  label="installed"
else
  cmd=(node dist/index.js acp)
  label="local dist"
fi

payload=$(
  node -e '
    const cwd = process.cwd();
    console.log(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } }));
    console.log(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd, mcpServers: [] } }));
  '
)

printf '%s\n' "$payload" | "${cmd[@]}" | node scripts/acp-assert.mjs
echo "ACP smoke passed ($label)"
