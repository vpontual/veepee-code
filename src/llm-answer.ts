/**
 * Reading a model's ANSWER out of a response, on a fleet where the answer is not
 * always in `content`.
 *
 * Two separate hazards, one module:
 *  - reasoning INLINE in content (`<think>…</think>`, or the orphan-`</think>`
 *    shape) — `answerText`;
 *  - reasoning on its OWN channel, with `content` left empty — `nonStreamingAnswer`.
 */

/**
 * The part of a model turn that is an ANSWER, with any reasoning stripped.
 *
 * Every heuristic here reads the assistant's own words, and reasoning is not
 * words the assistant said — it is words it thought. The two read completely
 * differently: a chain of thought says "Let me check…", "I need to…", "I should
 * just confirm" almost by definition, which is precisely `STATED_INTENT`. Judge
 * a turn on its reasoning and a greeting answered "Ready. What are we working
 * on?" looks like a stall (measured 2026-08-23: 1050 chars of reasoning against
 * 97 of answer), earns a force-act nudge, and the model then burns turns running
 * `pwd` and narrating the hidden [SYSTEM] nudge back to the user.
 *
 * Servers that split the channels are handled upstream (the reasoning never
 * enters `fullContent` at all). This covers the models that DON'T: an inline
 * `<think>…</think>` block, or the orphan-`</think>` shape where the trace is
 * emitted first and closed with a bare tag.
 */
export function answerText(content: string): string {
  const withoutBlocks = content.replace(/<think>[\s\S]*?<\/think>/g, '');
  const close = withoutBlocks.lastIndexOf('</think>');
  let answer: string;
  if (close >= 0) {
    // Orphan close: everything up to it was the trace.
    answer = withoutBlocks.slice(close + '</think>'.length);
  } else {
    // Unterminated open (the model hit its cap mid-thought): everything after
    // it is trace, and there is no answer beyond what came before.
    const open = withoutBlocks.indexOf('<think>');
    answer = open >= 0 ? withoutBlocks.slice(0, open) : withoutBlocks;
  }
  return answer.replace(/<\/?think>/g, '').trim();
}


/**
 * The answer from a NON-STREAMING chat response.
 *
 * `content` alone is not enough on this fleet and has not been for months.
 * vLLM with `--reasoning-parser deepseek_r1` puts the trace in its own channel,
 * and when the reply is short — or the token budget runs out mid-thought —
 * `content` comes back EMPTY while the channel holds everything. Measured
 * against the live gateway 2026-08-23 with the real compaction prompt:
 * `content` 0 chars, `thinking` 2,955 chars, `done_reason: "length"`.
 *
 * `07727dc` fixed this in the streaming adapter. Every non-streaming caller —
 * compaction, the knowledge-state summarizer, subagents, the benchmark scorer —
 * kept reading `.content` and silently receiving `''`. Nothing errored: the
 * summarizer returned null and the UI still said "Compacted", and subagents
 * reported `success: false, error: 'max turns reached'` no matter how well they
 * had done the work. That is why this lives in one shared place now: the next
 * caller gets it right by construction rather than by remembering.
 *
 * Field-name order matters. Ollama-shaped responses use `thinking`; OpenAI-shaped
 * ones use `reasoning_content` or `reasoning` (which spelling depends on the
 * server build — see `openai-adapter.ts`). Accept all four.
 */
export function nonStreamingAnswer(resp: unknown): string {
  const m = (resp as { message?: Record<string, unknown> } | null | undefined)?.message ?? {};
  const answer = answerText(String(m.content ?? ''));
  if (answer) return answer;
  // Reasoning-only turn: the channel holds the only thing the model produced.
  // Better a trace than the silent empty string that disabled four subsystems.
  const trace = m.thinking ?? m.reasoning_content ?? m.reasoning ?? '';
  return String(trace).trim();
}
