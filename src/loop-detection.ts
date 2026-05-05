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
