#!/usr/bin/env node

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const messages = [];
  for (const line of input.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      messages.push(JSON.parse(trimmed));
    } catch {
      console.error(`ACP smoke failed: non-JSON stdout line: ${JSON.stringify(trimmed.slice(0, 200))}`);
      process.exit(1);
    }
  }

  const init = messages.find((m) => m.id === 1);
  const sessionNew = messages.find((m) => m.id === 2);
  if (!init?.result?.agentCapabilities) {
    console.error('ACP smoke failed: initialize missing agentCapabilities');
    process.exit(1);
  }
  if (!sessionNew?.result?.sessionId) {
    console.error('ACP smoke failed: session/new missing sessionId');
    process.exit(1);
  }
});
