#!/usr/bin/env node
/**
 * Live tool smoke test — the real filesystem, real subprocesses, real sizes.
 *
 * Every check here corresponds to a bug that shipped with green unit tests and
 * was found hours later by a real-repo run. Unit tests asserted the code said
 * what was meant; none of them exercised a tool against a directory that did not
 * exist, a minified line, a command that leaves a child behind, or a file big
 * enough to matter. That is the gap this closes, before the commit rather than
 * after it.
 *
 *   npm run smoke            # tools + fleet
 *   node scripts/tool-smoke.mjs
 */
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerCodingTools } from '../dist/tools/coding.js';

const tools = registerCodingTools();
const tool = (n) => tools.find((t) => t.name === n);
let failures = 0;

function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
}

const dir = await mkdtemp(join(tmpdir(), 'vcode-toolsmoke-'));
try {
  // 1. write_file into a directory that does not exist yet.
  //    Shipped broken: a bare ENOENT, the model retried the identical call, the
  //    loop guard killed the run. 432 seconds, logged as the model being stuck.
  const nested = join(dir, 'server', 'lib', 'new.mjs');
  const w = await tool('write_file').execute({ path: nested, content: 'export const x = 1;\n' });
  check('write_file creates parent directories', w.success && existsSync(nested), w.error ?? '');

  // 2. bash reports a real exit code even when a child outlives the command.
  //    Shipped broken: the grace path called ok() unconditionally, so a failing
  //    test run that started a watcher reported success.
  const b = await tool('bash').execute({ command: 'sleep 20 & echo working; exit 3', timeout: 30_000 });
  check('bash reports exit 3 despite a lingering child',
    b.success === false && String(b.error).includes('Exit code 3'), String(b.error ?? '').slice(0, 60));

  // 3. bash keeps BOTH ends of a large output.
  //    Shipped broken twice: head-only truncation threw away the error at the
  //    end, then a 192KB-per-end cap put 84% of the context window in one result.
  const big = await tool('bash').execute({
    command: 'echo HEAD_MARKER; for i in $(seq 1 40000); do echo "filler line $i"; done; echo TAIL_MARKER',
    timeout: 60_000,
  });
  const out = String(big.output ?? '');
  check('bash keeps head and tail and bounds the size',
    out.includes('HEAD_MARKER') && out.includes('TAIL_MARKER') && out.length < 80_000,
    `${out.length} chars`);

  // 4. grep survives a minified line.
  //    Shipped broken: capped by LINE COUNT, so one match in a bundle was ~450k
  //    chars and the next request died at 128001 input tokens.
  await writeFile(join(dir, 'bundle.js'), `x${'a'.repeat(300_000)}needle${'b'.repeat(300_000)}\n`);
  const g = await tool('grep').execute({ pattern: 'needle', path: dir });
  check('grep clips a minified line', g.success && String(g.output).length < 40_000,
    `${String(g.output ?? '').length} chars`);

  // 5. read_file bounds a large file AND says how to continue.
  await writeFile(join(dir, 'big.ts'), Array.from({ length: 8_000 }, (_, i) => `line ${i}`).join('\n'));
  const r = await tool('read_file').execute({ path: join(dir, 'big.ts') });
  check('read_file truncates loudly with a continuation offset',
    /showing lines|truncated/.test(String(r.output)) && String(r.output).includes('offset='));

  // 6. edit_file applies when the model gets a MIDDLE line wrong — and refuses
  //    when it cannot tell which block was meant.
  const target = join(dir, 'total.js');
  await writeFile(target, [
    'function total(items) {', '  let sum = 0;', '  for (const i of items) sum += i.price;',
    '  return sum;', '}', '',
  ].join('\n'));
  await tool('read_file').execute({ path: target });
  const e = await tool('edit_file').execute({
    path: target,
    old_string: ['function total(items) {', '  let sum = 0;', '  for (const i of items) sum += i.cost;', '  return sum;', '}'].join('\n'),
    new_string: 'function total(items) { return 0; }',
  });
  check('edit_file recovers a wrong middle line', e.success, String(e.error ?? '').slice(0, 80));
  check('edit applied to disk', (await readFile(target, 'utf-8')).includes('return 0;'));

  // 7. A miss quotes the real region so the next attempt can succeed.
  const miss = await tool('edit_file').execute({
    path: target, old_string: 'function nonexistent() {\n  return 1;\n}', new_string: 'x',
  });
  check('an edit miss shows the file as it actually reads',
    miss.success === false && /copy this exactly|not found/.test(String(miss.error)),
    String(miss.error ?? '').slice(0, 60));
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? '\ntool smoke: PASS' : `\ntool smoke: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
