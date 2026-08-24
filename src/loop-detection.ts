import { createHash } from 'node:crypto';
import type { ToolCall } from 'ollama';

export const LOOP_WINDOW = 10;
export const LOOP_MAX_REPEATS = 5;

export interface SignedStep {
  signature: string;
}

/**
 * Hash both tool input AND output. "Same call, same output" is the stuck
 * signal. "Same call, different output" is productive iteration.
 */
export function signatureOf(
  toolCalls: ToolCall[],
  resultsByCall: string[],
): string {
  if (toolCalls.length === 0) return '';
  if (resultsByCall.length !== toolCalls.length) {
    throw new Error('signatureOf: resultsByCall length must match toolCalls length');
  }
  const h = createHash('sha256');
  for (let i = 0; i < toolCalls.length; i++) {
    const call = toolCalls[i];
    h.update(call.function.name);
    h.update('\x00');
    h.update(JSON.stringify(call.function.arguments ?? {}));
    h.update('\x00');
    h.update(resultsByCall[i] ?? '');
    h.update('\x00');
  }
  return h.digest('hex');
}

/**
 * Returns the repeated signature when the most recent {@link LOOP_WINDOW} steps
 * include any signature appearing more than {@link LOOP_MAX_REPEATS} times.
 * Returns null otherwise.
 */
export function detectStuckSignature(steps: SignedStep[]): string | null {
  if (steps.length < LOOP_WINDOW) return null;
  const window = steps.slice(-LOOP_WINDOW);
  const counts = new Map<string, number>();
  for (const step of window) {
    if (!step.signature) continue;
    const next = (counts.get(step.signature) ?? 0) + 1;
    counts.set(step.signature, next);
    if (next > LOOP_MAX_REPEATS) return step.signature;
  }
  return null;
}

/** How many times the SAME failing call may repeat before we call it stuck. */
export const REPEATED_FAILURE_LIMIT = 3;

/**
 * Signature of the CALL only — name and arguments, not the result.
 */
export function callSignatureOf(toolCalls: ToolCall[]): string {
  if (toolCalls.length === 0) return '';
  const h = createHash('sha256');
  for (const call of toolCalls) {
    h.update(call.function.name);
    h.update('\x00');
    h.update(JSON.stringify(call.function.arguments ?? {}));
    h.update('\x00');
  }
  return h.digest('hex');
}

export interface SignedStep2 extends SignedStep {
  /** Call-only signature. */
  callSignature?: string;
  /** True when every tool call in the step failed. */
  allFailed?: boolean;
  /** True when this step successfully changed a file. */
  mutated?: boolean;
}

/**
 * The loop the byte-identical detector cannot see.
 *
 * `detectStuckSignature` hashes the RESULT too, so it only fires when the output
 * is byte-identical five times over. The failure that actually happens with a
 * mid-size model is an edit that keeps missing: `old_string` not found, again and
 * again, with the error text varying slightly each time — a different line
 * quoted, a different nearby snippet — so no two signatures match and the run
 * burns its whole budget. It is the single most reported failure of this class
 * in other harnesses.
 *
 * So: the same call, repeated, FAILING every time, is stuck regardless of what
 * the error says. Requiring failure is what keeps this off productive
 * iteration — the same `bash` command run three times as a build progresses is
 * fine, because those calls succeeded.
 */
export function detectRepeatedFailure(steps: SignedStep2[]): string | null {
  const window = steps.slice(-LOOP_WINDOW);
  const counts = new Map<string, number>();
  for (const step of window) {
    // A SUCCESSFUL EDIT RESETS THE COUNT, and this is the difference between a
    // loop and ordinary work. Edit, run the tests, they fail, edit again, run
    // again — the command is byte-identical every time and failing every time,
    // and it is exactly what fixing a bug looks like. Measured on a real replay
    // task: an agent 34 tool calls into a working change was stopped for
    // running `npm test` three times, having modified three files in between.
    // The world changed between those calls; only an unchanged world makes a
    // repeat pointless.
    if (step.mutated) counts.clear();
    if (!step.callSignature || !step.allFailed) continue;
    const next = (counts.get(step.callSignature) ?? 0) + 1;
    counts.set(step.callSignature, next);
    if (next >= REPEATED_FAILURE_LIMIT) return step.callSignature;
  }
  return null;
}
