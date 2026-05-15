#!/usr/bin/env node
/**
 * ACP integration smoke test.
 * Runs a full session: initialize → session/new → session/prompt → validate stream.
 * Requires the Ollama fleet to be reachable (10.0.153.99:11434).
 *
 * Usage:
 *   node scripts/acp-integration.mjs              (dev build)
 *   node scripts/acp-integration.mjs --installed  (installed binary)
 */

import { spawn } from 'child_process';
import { createInterface } from 'readline';

const args = process.argv.slice(2);
const isInstalled = args.includes('--installed');
const bin = isInstalled ? '/home/vp/.local/bin/vcode' : 'node';
const binArgs = isInstalled ? ['acp'] : ['dist/index.js', 'acp'];
const label = isInstalled ? 'installed' : 'local dist';

// ── Helpers ──────────────────────────────────────────────────────────────────

function fail(msg) {
  console.error(`\n✗ ACP integration failed: ${msg}`);
  process.exit(1);
}

function ok(msg) {
  console.log(`  ✓ ${msg}`);
}

function warn(msg) {
  console.log(`  ~ ${msg}`);
}

function assert(cond, msg) {
  if (!cond) fail(msg);
}

// ── Protocol client ───────────────────────────────────────────────────────────

const child = spawn(bin, binArgs, {
  stdio: ['pipe', 'pipe', 'inherit'],
  cwd: process.cwd(),
});

const rl = createInterface({ input: child.stdout });
const pending = new Map();
const notifications = [];
let idSeq = 0;

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    fail(`non-JSON stdout line: ${JSON.stringify(trimmed.slice(0, 200))}`);
    return;
  }
  if (msg.id != null && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(`[${msg.error.code}] ${msg.error.message}`));
    else resolve(msg.result);
  } else {
    notifications.push(msg);
  }
});

child.on('error', (e) => fail(`spawn error: ${e.message}`));

function send(method, params, timeoutMs = 90_000) {
  return new Promise((resolve, reject) => {
    const id = ++idSeq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    pending.set(id, {
      resolve: (r) => { clearTimeout(timer); resolve(r); },
      reject:  (e) => { clearTimeout(timer); reject(e); },
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

// ── Test ──────────────────────────────────────────────────────────────────────

console.log(`\nACP integration test (${label})`);

try {
  // ── 1. initialize ──────────────────────────────────────────────────────────
  process.stdout.write('initialize ... ');
  const initResult = await send('initialize', { protocolVersion: 1 });
  assert(initResult?.agentCapabilities, 'missing agentCapabilities');
  assert(initResult?.agentInfo?.name, 'missing agentInfo.name');
  assert(initResult?.protocolVersion === 1, 'protocolVersion mismatch');
  console.log('ok');
  ok(`agent: ${initResult.agentInfo.name} v${initResult.agentInfo.version}`);
  ok(`capabilities: loadSession=${initResult.agentCapabilities.loadSession}, mcp=${JSON.stringify(initResult.agentCapabilities.mcpCapabilities)}`);

  // ── 2. session/new ─────────────────────────────────────────────────────────
  process.stdout.write('session/new ... ');
  const sessionResult = await send('session/new', { cwd: process.cwd(), mcpServers: [] });
  assert(sessionResult?.sessionId, 'missing sessionId');
  assert(Array.isArray(sessionResult?.configOptions), 'missing configOptions');
  assert(sessionResult?.modes?.currentModeId, 'missing modes.currentModeId');
  const sessionId = sessionResult.sessionId;
  const configIds = sessionResult.configOptions.map((o) => o.id);
  console.log('ok');
  ok(`sessionId: ${sessionId}`);
  ok(`configOptions: [${configIds.join(', ')}]`);
  ok(`mode: ${sessionResult.modes.currentModeId}`);

  const modelOpt = sessionResult.configOptions.find((o) => o.id === 'model');
  if (modelOpt) ok(`model: ${modelOpt.currentValue} (${modelOpt.options?.length ?? 0} available)`);

  // ── 3. session/prompt — streaming ─────────────────────────────────────────
  process.stdout.write('session/prompt ... ');
  const notifsBefore = notifications.length;
  const promptResult = await send(
    'session/prompt',
    { sessionId, prompt: [{ type: 'text', text: 'Reply with exactly the word: ok' }] },
    120_000,
  );
  assert(promptResult?.stopReason, 'missing stopReason');
  console.log(`ok (stopReason: ${promptResult.stopReason})`);

  const newNotifs = notifications.slice(notifsBefore);
  const updates = newNotifs
    .filter((n) => n.method === 'session/update')
    .map((n) => n.params?.update?.sessionUpdate);

  assert(updates.length > 0, 'no session/update notifications received');
  assert(updates.includes('agent_message_chunk'), 'no agent_message_chunk — response text never streamed');

  const uniqueUpdates = [...new Set(updates)];
  ok(`stream updates: [${uniqueUpdates.join(', ')}]`);

  if (updates.includes('agent_thought_chunk')) {
    ok('agent_thought_chunk present (model thinking confirmed)');
  } else {
    warn('no agent_thought_chunk (model may not support thinking, or thinking was empty)');
  }

  if (updates.includes('tool_call')) {
    ok('tool_call present');
    if (updates.includes('tool_call_update')) ok('tool_call_update present');
    else warn('tool_call seen but no tool_call_update — result may have been dropped');
  } else {
    warn('no tool_call (prompt did not trigger tool use — expected for simple prompt)');
  }

  // ── 4. session/set_config_option ──────────────────────────────────────────
  process.stdout.write('session/set_config_option (mode=plan) ... ');
  const configResult = await send('session/set_config_option', {
    sessionId,
    configId: 'mode',
    value: 'plan',
  });
  assert(Array.isArray(configResult?.configOptions), 'missing configOptions in response');
  const modeOpt = configResult.configOptions.find((o) => o.id === 'mode');
  assert(modeOpt?.currentValue === 'plan', `mode not updated to plan, got: ${modeOpt?.currentValue}`);
  console.log('ok');
  ok(`mode now: ${modeOpt.currentValue}`);

  // Restore to act
  await send('session/set_config_option', { sessionId, configId: 'mode', value: 'act' });

  // ── 5. session/list ────────────────────────────────────────────────────────
  process.stdout.write('session/list ... ');
  const listResult = await send('session/list', {});
  assert(Array.isArray(listResult?.sessions), 'missing sessions array');
  console.log('ok');
  ok(`${listResult.sessions.length} stored session(s)`);

  // ── 6. session/close ──────────────────────────────────────────────────────
  process.stdout.write('session/close ... ');
  await send('session/close', { sessionId });
  console.log('ok');

  console.log(`\n✓ ACP integration passed (${label})\n`);
} catch (e) {
  fail(e.message);
} finally {
  child.stdin.end();
  await new Promise((r) => child.on('close', r));
}
