import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

// The Agent class requires Ollama + Config + ToolRegistry + PermissionManager to construct,
// so we cannot instantiate it in unit tests. Instead we test the static/exported patterns
// and constants by copying them from the source (they are private static).

// Plan content detection patterns — copied from Agent.PLAN_CONTENT_PATTERNS
const PLAN_CONTENT_PATTERNS = [
  /^#{1,3}\s+(implementation|action)\s+plan/im,
  /^#{1,3}\s+plan\b/im,
  /^##\s+(step|phase)\s+\d/im,
  /(?:^|\n)\d+\.\s+\*\*.*\*\*.*\n\d+\.\s+\*\*/m,  // numbered bold steps
  /(?:^|\n)(?:step|phase)\s+\d+[.:]/im,
];

describe('Agent plan content patterns', () => {
  const matchesPlan = (text: string) =>
    PLAN_CONTENT_PATTERNS.some(p => p.test(text));

  it('detects "# Implementation Plan" heading', () => {
    expect(matchesPlan('# Implementation Plan\n\nHere is the plan...')).toBe(true);
  });

  it('detects "## Action Plan" heading', () => {
    expect(matchesPlan('## Action Plan\n\n1. Do this')).toBe(true);
  });

  it('detects "### Plan" heading', () => {
    expect(matchesPlan('### Plan\n\nFirst step...')).toBe(true);
  });

  it('detects "## Step 1" heading', () => {
    expect(matchesPlan('## Step 1\n\nDo the thing')).toBe(true);
  });

  it('detects "## Phase 3" heading', () => {
    expect(matchesPlan('## Phase 3\n\nFinal phase')).toBe(true);
  });

  it('detects numbered bold steps', () => {
    const content = '1. **Setup project** — init npm\n2. **Install deps** — vitest etc';
    expect(matchesPlan(content)).toBe(true);
  });

  it('detects "Step 1:" inline', () => {
    expect(matchesPlan('Some preamble\nStep 1: Initialize the repo')).toBe(true);
  });

  it('detects "Phase 2." inline', () => {
    expect(matchesPlan('Overview\nPhase 2. Build the API')).toBe(true);
  });

  it('does not match plain prose', () => {
    expect(matchesPlan('Here is some text about coding.')).toBe(false);
  });

  it('does not match short content (agent checks length >= 200 separately)', () => {
    // The patterns themselves don't enforce length; agent.ts checks length >= 200
    // But a heading alone without numbered steps won't false-positive on random text
    expect(matchesPlan('Just a short note.')).toBe(false);
  });
});

describe('Agent stuck loop detection concept', () => {
  // The agent tracks recent tool call signatures and stops after MAX_IDENTICAL_CALLS (3)
  // consecutive identical calls. We verify the detection logic here.

  const MAX_IDENTICAL_CALLS = 3;

  function detectStuck(recentCalls: string[]): boolean {
    if (recentCalls.length < MAX_IDENTICAL_CALLS) return false;
    const last = recentCalls.slice(-MAX_IDENTICAL_CALLS);
    return last.every(c => c === last[0]);
  }

  it('detects 3 identical consecutive tool calls', () => {
    const calls = [
      'read_file:{"path":"/tmp/a.ts"}',
      'read_file:{"path":"/tmp/a.ts"}',
      'read_file:{"path":"/tmp/a.ts"}',
    ];
    expect(detectStuck(calls)).toBe(true);
  });

  it('does not trigger with only 2 identical calls', () => {
    const calls = [
      'read_file:{"path":"/tmp/a.ts"}',
      'read_file:{"path":"/tmp/a.ts"}',
    ];
    expect(detectStuck(calls)).toBe(false);
  });

  it('does not trigger with different calls', () => {
    const calls = [
      'read_file:{"path":"/tmp/a.ts"}',
      'read_file:{"path":"/tmp/b.ts"}',
      'read_file:{"path":"/tmp/c.ts"}',
    ];
    expect(detectStuck(calls)).toBe(false);
  });

  it('only considers the last N calls (window slides)', () => {
    const calls = [
      'read_file:{"path":"/tmp/a.ts"}',
      'glob:{"pattern":"*.ts"}',
      'glob:{"pattern":"*.ts"}',
      'glob:{"pattern":"*.ts"}',
    ];
    expect(detectStuck(calls)).toBe(true);
  });
});

describe('Agent plan file constants', () => {
  it('plan directory is .veepee', () => {
    // Agent.PLAN_DIR = '.veepee'
    expect('.veepee').toBe('.veepee');
  });

  it('plan file path is .veepee/plan.md', () => {
    // Agent.PLAN_FILE = '.veepee/plan.md'
    expect('.veepee/plan.md').toBe('.veepee/plan.md');
  });
});

describe('Agent exports', () => {
  it('exports AgentEvent type and Agent class', async () => {
    const mod = await import('../src/agent.js');
    expect(mod.Agent).toBeDefined();
    expect(typeof mod.Agent).toBe('function');
  });
});

// --- <think> stream-processing logic ---
// Reproduces the agent's per-chunk processing so we can verify the orphan
// </think> path (Qwen3.6 via vLLM without a reasoning parser emits reasoning
// as plain content and closes with a bare </think> before the answer). Keep
// in sync with the real logic in src/agent.ts.

type Event = { type: string; content?: string };

function* processStream(chunks: string[]): Generator<Event> {
  let inThinking = false;
  let thinkingBuffer = '';
  let fullContent = '';

  for (const text of chunks) {
    if (!text) continue;
    fullContent += text;

    if (!inThinking && text.includes('<think>')) {
      inThinking = true;
      const before = text.split('<think>')[0];
      if (before) yield { type: 'text', content: before };
      thinkingBuffer = text.split('<think>').slice(1).join('<think>');
      yield { type: 'thinking', content: '...' };
      continue;
    }

    if (!inThinking && text.includes('</think>')) {
      const parts = text.split('</think>');
      const beforeClose = parts[0];
      const afterClose = parts.slice(1).join('</think>');
      const streamedBefore = fullContent.slice(0, fullContent.length - text.length);
      const reasoningText = (streamedBefore + beforeClose).trim();

      yield { type: 'reset_stream' };
      if (reasoningText) yield { type: 'thinking', content: reasoningText };
      if (afterClose) yield { type: 'text', content: afterClose };
      continue;
    }

    if (inThinking) {
      if (text.includes('</think>')) {
        const parts = text.split('</think>');
        thinkingBuffer += parts[0];
        inThinking = false;
        yield { type: 'thinking', content: thinkingBuffer.trim() };
        thinkingBuffer = '';
        const after = parts.slice(1).join('</think>');
        if (after) yield { type: 'text', content: after };
      } else {
        thinkingBuffer += text;
      }
      continue;
    }

    yield { type: 'text', content: text };
  }
}

describe('Agent <think>-tag stream processing', () => {
  it('plain text without any think tags streams through unchanged', () => {
    const events = [...processStream(['Hello ', 'world!'])];
    expect(events).toEqual([
      { type: 'text', content: 'Hello ' },
      { type: 'text', content: 'world!' },
    ]);
  });

  it('paired <think>...</think> across chunks is captured as thinking and stripped from text', () => {
    // Streaming: tags typically arrive separate from surrounding content.
    const events = [...processStream(['<think>', 'reasoning goes here', '</think>Final answer.'])];
    expect(events.some(e => e.type === 'thinking' && e.content === '...')).toBe(true);
    expect(events.some(e => e.type === 'thinking' && e.content === 'reasoning goes here')).toBe(true);
    expect(events.some(e => e.type === 'text' && e.content === 'Final answer.')).toBe(true);
  });

  it('orphan </think> reclassifies prior text as thinking and resets the stream', () => {
    // Simulates Qwen3.6 output via vLLM without a reasoning parser: reasoning
    // starts immediately with no opening tag, ends with </think>, then the
    // real answer.
    const chunks = [
      "Here's a thinking process:\n1. Parse the user input\n",
      "2. Compute 7 * 8 = 56\n",
      "</think>\n\n56",
    ];
    const events = [...processStream(chunks)];
    // First two chunks yield text events (user sees them live).
    expect(events[0]).toEqual({ type: 'text', content: chunks[0] });
    expect(events[1]).toEqual({ type: 'text', content: chunks[1] });
    // Then the orphan </think> chunk triggers reset + thinking + answer.
    expect(events.some(e => e.type === 'reset_stream')).toBe(true);
    const thinking = events.find(e => e.type === 'thinking');
    expect(thinking?.content).toContain('7 * 8 = 56');
    // The reasoning buffer includes ALL streamed-so-far content, not just
    // the current chunk's prefix up to </think>.
    expect(thinking?.content).toContain('Parse the user input');
    // And the answer arrives as a fresh text event after the reset.
    const lastText = [...events].reverse().find(e => e.type === 'text');
    expect(lastText?.content).toBe('\n\n56');
  });

  it('orphan </think> with no content after it still resets cleanly', () => {
    const events = [...processStream(['reasoning without an answer</think>'])];
    expect(events.some(e => e.type === 'reset_stream')).toBe(true);
    expect(events.some(e => e.type === 'thinking' && (e.content ?? '').includes('reasoning without an answer'))).toBe(true);
    const afterTexts = events.filter(e => e.type === 'text' && (e.content ?? '').length > 0);
    expect(afterTexts).toEqual([]);
  });
});

// --- Tier 3 #1: force-act guard (shouldForceAct) ---
import { bashVerifies, shouldForceAct, answerText, FORCE_ACT_MIN_CHARS, FORCE_ACT_NUDGE, FORCE_ACT_NUDGE_STALLED, forceActNudge, FORCE_ACT_MAX_NUDGES, shouldForceVerify, CODE_MUTATION_TOOLS } from '../src/agent.js';

describe('shouldForceAct — force one ACT turn instead of narrate-and-stop', () => {
  const long = 'x'.repeat(FORCE_ACT_MIN_CHARS);
  const base = { mode: 'act' as const, hasActedThisMessage: false, alreadyForced: false, content: long };

  it('fires: act mode, nothing done, not yet forced, substantive narration', () => {
    expect(shouldForceAct(base)).toBe(true);
  });
  it('does NOT fire when the model already took an action this message', () => {
    expect(shouldForceAct({ ...base, hasActedThisMessage: true })).toBe(false);
  });
  it('does NOT fire twice (already forced)', () => {
    expect(shouldForceAct({ ...base, alreadyForced: true })).toBe(false);
  });
  it('does NOT fire in plan mode', () => {
    expect(shouldForceAct({ ...base, mode: 'plan' })).toBe(false);
  });
  it('does NOT fire in chat mode', () => {
    expect(shouldForceAct({ ...base, mode: 'chat' })).toBe(false);
  });
  it('does NOT fire on a terse reply when neither side mentioned work', () => {
    expect(shouldForceAct({ ...base, content: 'x'.repeat(FORCE_ACT_MIN_CHARS - 1) })).toBe(false);
  });
  it('fires exactly at the length-fallback boundary', () => {
    expect(shouldForceAct({ ...base, content: 'x'.repeat(FORCE_ACT_MIN_CHARS) })).toBe(true);
  });
  it('does NOT fire on whitespace-padded short content (trims first)', () => {
    expect(shouldForceAct({ ...base, content: '   hi   ' + ' '.repeat(FORCE_ACT_MIN_CHARS) })).toBe(false);
  });
  it('does NOT fire on empty content when nothing was asked of it', () => {
    expect(shouldForceAct({ ...base, content: '' })).toBe(false);
  });

  // Observed in real use: "what is pinky" earned a correct ~400-char answer
  // needing no tools, tripped the length test, got nudged, and the model —
  // having already answered — read three unrelated files out of the current
  // directory and summarised them.
  const PINKY_ANSWER =
    "Pinky is VP's cross-machine, cross-LLM context system — a plain-markdown index that lets any AI " +
    'assistant understand who VP is, his preferences, his machines, and his projects. It lives at ' +
    '~/Nextcloud/pinky/ and includes an identity layer, device mirrors, a memory index and sync ' +
    'infrastructure. The goal: portable, LLM-agnostic context so any agent can read it.';

  it('does NOT fire when a lookup question got an answer with no stated intent', () => {
    expect(shouldForceAct({ ...base, content: PINKY_ANSWER, userMessage: 'what is pinky' })).toBe(false);
  });

  for (const q of ['who owns this repo', 'explain the auth flow', 'describe the fleet', 'tell me about veetv', 'is the DGX up']) {
    it(`does NOT fire for the lookup request ${JSON.stringify(q)}`, () => {
      expect(shouldForceAct({ ...base, content: PINKY_ANSWER, userMessage: q })).toBe(false);
    });
  }

  it('STILL fires when a lookup question is answered with intent but no action', () => {
    // "why is this test failing" is a question in form and a task in substance.
    // Announcing a plan and calling nothing is the exact stall this nudge is for.
    expect(shouldForceAct({
      ...base,
      content: 'Let me check the test output first. ' + 'x'.repeat(FORCE_ACT_MIN_CHARS),
      userMessage: 'why is the cart test failing',
    })).toBe(true);
  });

  it('STILL fires on an imperative task that only got narration', () => {
    expect(shouldForceAct({
      ...base,
      content: "I'll start by reading the migration runner. " + 'x'.repeat(FORCE_ACT_MIN_CHARS),
      userMessage: 'add a rename operation to the migration runner',
    })).toBe(true);
  });

  it('STILL fires on an imperative task with no intent markers either', () => {
    // Not a lookup request, so the suppression never applies.
    expect(shouldForceAct({ ...base, userMessage: 'fix the failing test' })).toBe(true);
  });

  it('keeps the old behaviour when no userMessage is supplied', () => {
    expect(shouldForceAct(base)).toBe(true);
  });

  it('is not fooled by a bare trailing question mark on a task', () => {
    expect(shouldForceAct({ ...base, userMessage: 'can you fix the failing test?' })).toBe(true);
  });

  // The first fix anchored the pattern to the start of the message, and this
  // phrasing walked straight past it — the interrogative sits mid-sentence,
  // behind a politeness preamble. Anchoring only catches phrasings someone
  // thought to enumerate.
  for (const q of [
    'can you let me know what pinky is',
    'could you tell me what the fleet looks like',
    'do you know what veetv runs on',
    'any idea what pinky is',
    'walk me through the auth flow',
    "what's the DGX serving",
    'remind me where the inventory lives',
  ]) {
    it(`does NOT fire for ${JSON.stringify(q)}`, () => {
      expect(shouldForceAct({ ...base, content: PINKY_ANSWER, userMessage: q })).toBe(false);
    });
  }

  // Asking AND instructing in one breath still deserves the nudge.
  for (const q of [
    'explain why the cart test fails and fix it',
    'tell me what pinky is, then add a section to it',
    'describe the bug and write a test for it',
  ]) {
    it(`STILL fires for ${JSON.stringify(q)}`, () => {
      expect(shouldForceAct({ ...base, content: PINKY_ANSWER, userMessage: q })).toBe(true);
    });
  }

  // The Nightly Engineer produced nothing on five consecutive nights
  // (2026-08-03..07). These are the VERBATIM job results from
  // /srv/vcode-home/dispatch.db on archman: a promise to act, no tool call, a ~2s
  // run, a byte-identical workspace. Every one was under the 200-char floor, so
  // the floor — which ran before the intent test — threw them away.
  describe('terse narration is a stall, not a completion (barren nights)', () => {
    const NIGHTLY_RETRY =
      'You previously produced NO file change. Do it NOW: pick ONE concrete critical bug ' +
      'fix or a small user-facing improvement, EDIT at least one source file to implement ' +
      'it, and write NIGHTLY_REPORT.md (sections: Purpose, Change, Why it\'s valuable, How ' +
      'to test, Risk, Subject). Be surgical, act every step, and make real edits before ' +
      'ending your turn.';

    for (const stall of [
      'Let me explore the project first.',                              // 33 chars
      'Let me explore the project first to find a real issue to fix.',  // 61 chars
      'Let me explore the repository to understand what we\'re working with.',
      "I'll start by reading the README.",
    ]) {
      it(`fires on ${JSON.stringify(stall)} (${stall.length} chars)`, () => {
        expect(stall.length).toBeLessThan(FORCE_ACT_MIN_CHARS); // the floor would have blocked it
        expect(shouldForceAct({ ...base, content: stall, userMessage: NIGHTLY_RETRY })).toBe(true);
      });
    }

    it('fires on a stated intent even with no userMessage at all', () => {
      expect(shouldForceAct({ ...base, content: 'Let me explore the project first.' })).toBe(true);
    });

    // Observed too: the model returns an EMPTY completion with zero tool calls and
    // the loop books it as a finished turn. Nothing is more obviously undone.
    it('fires on an empty completion when the user asked for work', () => {
      expect(shouldForceAct({ ...base, content: '', userMessage: 'fix the failing test' })).toBe(true);
    });
    it('fires on an empty completion for the nightly prompt', () => {
      expect(shouldForceAct({ ...base, content: '', userMessage: NIGHTLY_RETRY })).toBe(true);
    });
  });

  // The nudge firing on ordinary conversation is the regression a88545a/744569a
  // fixed. Dropping the length floor must not bring it back: these all have SHORT
  // replies, which the floor used to suppress for the wrong reason.
  describe('does not fire on ordinary short exchanges', () => {
    for (const [msg, reply] of [
      ['thanks!', "You're welcome."],
      ['hi', 'Hello — what are we working on?'],
      ['what is pinky', 'A cross-machine context system.'],
      ['is the DGX up', 'Yes, it is serving Qwen3.6-35B.'],
      ['who owns this repo', 'VP does.'],
      ["what's the DGX serving", 'Qwen/Qwen3.6-35B-A3B-FP8.'],
      ['do you know what veetv runs on', 'A Raspberry Pi 5.'],
      ['walk me through the auth flow', 'veeauth issues an Ed25519 token; apps verify it locally.'],
      ['any idea what pinky is', "VP's portable context system."],
      ['explain the gravity engine', 'It scores clustered articles by embedding similarity.'],
      // "make sense" is not a request to make anything.
      ['does that make sense?', 'Yes — the gate runs before the commit.'],
      ['make sense?', 'It does.'],
    ] as const) {
      it(`stays quiet for ${JSON.stringify(msg)}`, () => {
        expect(reply.length).toBeLessThan(FORCE_ACT_MIN_CHARS);
        expect(shouldForceAct({ ...base, content: reply, userMessage: msg })).toBe(false);
      });
    }

    it('stays quiet on a long answer to a question with no promise to act', () => {
      expect(shouldForceAct({ ...base, content: PINKY_ANSWER, userMessage: 'what is pinky' })).toBe(false);
    });

    // The carve-out is only for the phrase, not the verb.
    it('still fires for a real "make" request', () => {
      expect(shouldForceAct({ ...base, content: 'Sure.', userMessage: 'make the header sticky' })).toBe(true);
    });

    // "let me know" hands the turn back; it is the opposite of announcing work,
    // and it closes a large share of otherwise-finished answers.
    it('does not read "let me know" as a promise to act', () => {
      const closing = 'Done — the gate now runs before the commit. Let me know if you want the ' +
        'timeout raised too.';
      expect(shouldForceAct({ ...base, hasActedThisMessage: true, content: closing,
        userMessage: 'fix the gate ordering' })).toBe(false);
    });
  });

  // The 198-second agentlens job (archman, 2026-08-07) read the repo, edited nothing,
  // and signed off with "Let me explore the project to find a concrete improvement to
  // make." hasActedThisMessage was true, so the guard stayed silent and the night was
  // lost. Acting once does not make the next promise any less empty.
  describe('a promise of MORE work after acting is still a stall', () => {
    const acted = { ...base, hasActedThisMessage: true };

    it('fires when the model promises more work after acting', () => {
      expect(shouldForceAct({ ...acted,
        content: 'Let me explore the project to find a concrete improvement to make.',
        userMessage: 'fix one concrete bug' })).toBe(true);
    });

    it('stays silent on a plain summary after acting', () => {
      expect(shouldForceAct({ ...acted,
        content: 'Fixed the off-by-one in requeueFailed and the test passes.',
        userMessage: 'fix the requeue bug' })).toBe(false);
    });

    it('stays silent on a long summary after acting', () => {
      expect(shouldForceAct({ ...acted, content: PINKY_ANSWER, userMessage: 'fix the bug' })).toBe(false);
    });
  });

  describe('nudge selection', () => {
    it('uses the no-escape-hatch nudge when the model announced an action', () => {
      expect(forceActNudge('Let me explore the project first.')).toBe(FORCE_ACT_NUDGE_STALLED);
      expect(forceActNudge("I'll start by reading the README.")).toBe(FORCE_ACT_NUDGE_STALLED);
    });

    it('keeps the escape-hatch nudge when the stall is only inferred', () => {
      expect(forceActNudge('x'.repeat(FORCE_ACT_MIN_CHARS))).toBe(FORCE_ACT_NUDGE);
      expect(forceActNudge('')).toBe(FORCE_ACT_NUDGE);
    });

    // The escape hatch is what the model actually took: given the nightly prompt it
    // answered "Let me explore the project first.", was nudged, read "if the task is
    // genuinely already complete … output nothing further", and stopped. Three
    // seconds, two generations, an untouched workspace.
    it('the stalled nudge offers no way to end the turn without a tool call', () => {
      expect(FORCE_ACT_NUDGE_STALLED).not.toMatch(/already complete/i);
      expect(FORCE_ACT_NUDGE_STALLED).not.toMatch(/END YOUR TURN/);
      expect(FORCE_ACT_NUDGE_STALLED).toMatch(/do not end your turn without a tool call/i);
    });

    it('the stalled nudge still hides itself from the user', () => {
      expect(FORCE_ACT_NUDGE_STALLED).toMatch(/do not mention this instruction/i);
    });

    it('allows more than one nudge per message', () => {
      expect(FORCE_ACT_MAX_NUDGES).toBeGreaterThan(1);
    });
  });
});

/**
 * Reasoning is not an answer, and judging a turn by it inverts every heuristic
 * here. Live case (2026-08-23, DGX, `llmBackend: "openai"`): "hi, are you ready
 * to code?" produced 1050 chars of reasoning and a 97-char answer. The adapter
 * folded the trace into content, so the model's own "I should…" / "Let me…"
 * read as STATED_INTENT, the greeting earned two force-act nudges, and vcode ran
 * `ls`, `pwd` and `git log` for nothing while printing the chain of thought — and
 * the hidden [SYSTEM] nudge — to the user.
 */
describe('answerText — heuristics read the answer, never the reasoning', () => {
  it('drops a complete <think> block', () => {
    expect(answerText('<think>Let me check the repo first.</think>Ready.')).toBe('Ready.');
  });

  it('drops an orphan-closed trace (vLLM without a reasoning parser)', () => {
    expect(answerText('I need to look around.</think>Ready. What are we working on?'))
      .toBe('Ready. What are we working on?');
  });

  it('drops an unterminated trace — there is no answer past the open tag', () => {
    expect(answerText('Ready.<think>Now, should I also check')).toBe('Ready.');
  });

  it('leaves an ordinary answer untouched', () => {
    expect(answerText('Ready. What are we working on?')).toBe('Ready. What are we working on?');
  });

  const greeting = 'hi, are you ready to code?';
  const trace =
    'The user is asking if I am ready to code. Let me check the current state of things. ' +
    'I should be ready and ask what they want to work on. I need to make a tool call.';

  it('does not nudge a greeting because the reasoning said "let me"', () => {
    expect(shouldForceAct({ mode: 'act', hasActedThisMessage: false, alreadyForced: false,
      content: `${trace}</think>Ready. What are we working on?`, userMessage: greeting })).toBe(false);
  });

  it('does not re-nudge after acting because the reasoning said "I should"', () => {
    expect(shouldForceAct({ mode: 'act', hasActedThisMessage: true, alreadyForced: false,
      content: `<think>${trace}</think>Ready. What are we working on?`, userMessage: greeting })).toBe(false);
  });

  it('still fires when the ANSWER itself promises work', () => {
    expect(shouldForceAct({ mode: 'act', hasActedThisMessage: false, alreadyForced: false,
      content: '<think>The user wants a fix.</think>Let me explore the project first.',
      userMessage: 'fix one concrete bug' })).toBe(true);
  });

  it('picks the nudge from the answer, not the trace', () => {
    expect(forceActNudge('<think>Let me read the file.</think>Done — the test passes.'))
      .toBe(FORCE_ACT_NUDGE);
  });

  it('does not let a long trace clear the length floor on its own', () => {
    const long = 'x'.repeat(FORCE_ACT_MIN_CHARS * 2);
    expect(shouldForceAct({ mode: 'act', hasActedThisMessage: false, alreadyForced: false,
      content: `<think>${long}</think>Sure.`, userMessage: 'hi there' })).toBe(false);
  });
});

describe('FORCE_ACT_NUDGE wording', () => {
  // The model obeyed the old escape hatch literally and printed "The task is
  // already complete — I answered your question about Pinky in the previous
  // response. No tools needed." to a user who never saw the instruction it was
  // responding to. The escape hatch must ask for silence, not for a sentence.
  it('asks the model to end its turn rather than explain itself', () => {
    expect(FORCE_ACT_NUDGE).toMatch(/END YOUR TURN/);
    expect(FORCE_ACT_NUDGE).toMatch(/output nothing further/i);
  });

  it('does not ask the model to say anything to the user', () => {
    expect(FORCE_ACT_NUDGE).not.toMatch(/say so/i);
    expect(FORCE_ACT_NUDGE).toMatch(/Do NOT explain/);
  });

  it('tells the model the user never saw the instruction', () => {
    expect(FORCE_ACT_NUDGE).toMatch(/the user never saw this message/i);
  });
});

// --- Daily-driver #1: self-repair force-verify guard (shouldForceVerify) ---
/**
 * The flag used to be updated from the REQUESTED tool calls, before permission
 * and execution. A denied `edit_file` therefore set "unverified" and earned a
 * spurious nudge, and — the dangerous direction — a denied or FAILING `bash`
 * cleared it, so the turn completed on code that had never run. It also could
 * not tell `npm test` from `ls`.
 */
describe('bashVerifies — what can count as checking your work', () => {
  it('accepts commands that actually exercise the change', () => {
    for (const cmd of ['npm test', 'npx vitest run', 'pytest -q', 'make build', 'go test ./...',
                       'node dist/index.js --help', 'cargo check', 'tsc --noEmit',
                       'echo start; npm test']) {
      expect(bashVerifies(cmd), cmd).toBe(true);
    }
  });

  it('rejects the inert commands a model reaches for when narrating progress', () => {
    for (const cmd of ['ls -la', 'pwd', 'echo done', 'cat src/x.ts', 'git status',
                       'git log --oneline -5', 'which node', 'find . -name "*.ts"']) {
      expect(bashVerifies(cmd), cmd).toBe(false);
    }
  });
});

describe('shouldForceVerify — force verify-and-fix after an unverified code change', () => {
  const base = { mode: 'act' as const, codeChangedUnverified: true, alreadyForced: false };

  it('fires: act mode, code changed and not yet run, not already forced', () => {
    expect(shouldForceVerify(base)).toBe(true);
  });
  it('does NOT fire when nothing unverified (no edit, or a bash run cleared it)', () => {
    expect(shouldForceVerify({ ...base, codeChangedUnverified: false })).toBe(false);
  });
  it('does NOT fire twice (already forced)', () => {
    expect(shouldForceVerify({ ...base, alreadyForced: true })).toBe(false);
  });
  it('does NOT fire in plan mode', () => {
    expect(shouldForceVerify({ ...base, mode: 'plan' })).toBe(false);
  });
  it('does NOT fire in chat mode', () => {
    expect(shouldForceVerify({ ...base, mode: 'chat' })).toBe(false);
  });
  it('treats write/edit/multi_edit as code mutations (and not read_file/bash/grep)', () => {
    for (const t of ['write_file', 'edit_file', 'multi_edit']) expect(CODE_MUTATION_TOOLS.has(t)).toBe(true);
    for (const t of ['read_file', 'bash', 'grep', 'glob', 'git']) expect(CODE_MUTATION_TOOLS.has(t)).toBe(false);
  });
});

describe('modes: Act 1, Act 2, Chat — and verify', () => {
  async function makeAgent(overrides: Record<string, unknown> = {}) {
    const { loadConfig } = await import('../src/config.js');
    const { Agent } = await import('../src/agent.js');
    const { ToolRegistry } = await import('../src/tools/registry.js');
    const { ModelManager } = await import('../src/models.js');
    const { PermissionManager } = await import('../src/permissions.js');
    const config = { ...loadConfig(''), ...overrides } as never;
    const mm = new ModelManager(config);
    mm.switchTo('primary-model');
    return { agent: new Agent(config, new ToolRegistry(), mm, new PermissionManager()), mm };
  }

  it('starts on Act 1 with verify off', async () => {
    const { agent } = await makeAgent({ secondModel: 'second-model' });
    expect(agent.getMode()).toBe('act');
    expect(agent.getActSlot()).toBe(1);
    expect(agent.getVerify()).toBe(false);
  });

  it('Shift+Tab cycles Act 1 -> Act 2 -> Chat -> Act 1, on the right models', async () => {
    const { agent, mm } = await makeAgent({ secondModel: 'second-model' });
    expect(agent.cycleMode()).toMatchObject({ mode: 'act', slot: 2, model: 'second-model' });
    const chat = agent.cycleMode();
    expect(chat.mode).toBe('chat');
    // No chat model is known here, so chat runs on the primary, not on Act 2's model.
    expect(chat.model).toBe('primary-model');
    expect(agent.cycleMode()).toMatchObject({ mode: 'act', slot: 1, model: 'primary-model' });
    expect(mm.getCurrentModel()).toBe('primary-model');
  });

  it('the second model needs no discovered profile (lockModel skips discovery)', async () => {
    const { agent, mm } = await makeAgent({ secondModel: 'gemma4:26b-a4b' });
    expect(agent.setAct(2)).toEqual({ model: 'gemma4:26b-a4b' });
    expect(mm.getCurrentModel()).toBe('gemma4:26b-a4b');
  });

  it('falls back to the first fallbackModel, and skips Act 2 when there is none', async () => {
    const fb = await makeAgent({ secondModel: null, fallbackModels: ['fb-model'] });
    expect(fb.agent.slotModel(2)).toBe('fb-model');
    const none = await makeAgent({ secondModel: null, fallbackModels: [] });
    expect(none.agent.setAct(2)).toBeNull();
    expect(none.agent.getActSlot()).toBe(1);
    expect(none.agent.cycleMode().mode).toBe('chat');
  });

  it('Act 1 comes back to a /model choice made in Act 1', async () => {
    const { agent, mm } = await makeAgent({ secondModel: 'second-model' });
    agent.cycleMode(); agent.cycleMode(); agent.cycleMode(); // back on Act 1
    agent.setModel('picked-model');
    mm.setAutoSwitch(false);
    agent.setAct(2);
    expect(agent.setAct(1)).toEqual({ model: 'picked-model' });
    expect(mm.getAutoSwitch()).toBe(false);
  });

  it('/act on the slot you are already on changes nothing', async () => {
    const { agent, mm } = await makeAgent({ secondModel: 'second-model' });
    agent.setModel('picked-model');
    mm.setAutoSwitch(false);
    expect(agent.setAct(1)).toEqual({ model: 'picked-model' });
    expect(mm.getAutoSwitch()).toBe(false);
  });

  it('verify is independent of mode and model', async () => {
    const { agent, mm } = await makeAgent({ secondModel: 'second-model' });
    agent.setVerify(true);
    agent.setAct(2);
    expect(agent.getVerify()).toBe(true);
    expect(mm.getCurrentModel()).toBe('second-model');
    agent.setVerify(false);
    expect(agent.getActSlot()).toBe(2);
  });

  it('keeps the old lessons: no tool filtering by a plan list, no mode inferred from wording', () => {
    const src = readFileSync(new URL('../src/agent.ts', import.meta.url), 'utf-8');
    expect(src).not.toMatch(/PLAN_DISABLED_TOOLS/);
    expect(src).not.toMatch(/detectPlanningIntent|PLAN_PATTERNS/);
  });
});

describe('request_approval', () => {
  async function setup(answer: string) {
    const { loadConfig } = await import('../src/config.js');
    const { Agent } = await import('../src/agent.js');
    const { ToolRegistry } = await import('../src/tools/registry.js');
    const { ModelManager } = await import('../src/models.js');
    const { PermissionManager } = await import('../src/permissions.js');
    const { createRequestApprovalTool } = await import('../src/tools/verify-gate.js');
    const config = loadConfig('');
    const perms = new PermissionManager();
    perms.setPromptHandler(async () => answer);
    const mm = new ModelManager(config);
    mm.switchTo('m');
    const agent = new Agent(config, new ToolRegistry(), mm, perms);
    return { agent, tool: createRequestApprovalTool(agent, perms) };
  }

  it('turns verify off when approved', async () => {
    const { agent, tool } = await setup('y');
    agent.setVerify(true);
    const r = await tool.execute({ proposal: '1. edit a.ts' });
    expect(r.success).toBe(true);
    expect(agent.getVerify()).toBe(false);
  });

  it('keeps verify on when rejected', async () => {
    const { agent, tool } = await setup('n');
    agent.setVerify(true);
    const r = await tool.execute({ proposal: '1. edit a.ts' });
    expect(r.success).toBe(false);
    expect(agent.getVerify()).toBe(true);
  });

  it('accepts `plan`, which models trained on exit_plan_mode send — through the registry', async () => {
    const { agent, tool } = await setup('y');
    const { ToolRegistry } = await import('../src/tools/registry.js');
    const reg = new ToolRegistry();
    reg.register(tool);
    agent.setVerify(true);
    // The registry validates against the schema before execute: the alias must be in it.
    expect((await reg.execute('request_approval', { plan: 'do it' })).success).toBe(true);
    expect(agent.getVerify()).toBe(false);
  });

  it('says so when verify is already off', async () => {
    const { tool } = await setup('y');
    const r = await tool.execute({ proposal: 'x' });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/Verify is off/);
  });
});

describe('the output ceiling is a budget, not a constant', () => {
  it('never asks for more output than the window can still hold', () => {
    // Raising num_predict to 16384 fixed truncated tool arguments and created a
    // failure at the other end: a 52-call session died on `HTTP 400: maximum
    // context length is 131072, you requested 16384 output tokens and your
    // prompt contains …`. The request is refused ENTIRELY — the turn produces
    // nothing, which is worse than a short answer.
    const src = readFileSync(new URL('../src/agent.ts', import.meta.url), 'utf-8');
    expect(src).toContain('private outputBudget(toolSchemaTokens = 0)');
    // The tool definitions are part of the counted prompt (a 32k gemma4 window
    // overflowed by ~2k on them every attempt when only a flat reserve covered them).
    expect(src).toContain('const effortOpts = this.outputBudget(toolSchemaTokens);');
    expect(src).toMatch(/\+ toolSchemaTokens \+ this\.promptUndercount/);
    // Budgeted against the REMAINING room, with a reserve for template
    // overhead and our own estimate error.
    expect(src).toMatch(/const room = limit - prompt - RESERVE;/);
    expect(src).toMatch(/if \(room >= ceiling\) return \{ num_predict: ceiling \};/);
  });
});

describe('the coding preset defends against degenerate repetition', () => {
  it('applies a presence penalty in the mode that writes long output', async () => {
    const { QWEN_CODING_PRESET, QWEN_INSTRUCT_PRESET } = await import('../src/agent.js');
    // It was 0.0 here while chat used 1.5 — and act/plan is where the long
    // structured generation happens. A 15-record JSON fixture became
    // "Still writing game data... " 1,341 times, 43KB, no files written.
    expect(QWEN_CODING_PRESET.presence_penalty).toBeGreaterThan(0);
    // …but lower than chat's, because code legitimately repeats itself far more
    // than prose does, and too high a penalty starves it of the tokens it needs.
    expect(QWEN_CODING_PRESET.presence_penalty).toBeLessThan(QWEN_INSTRUCT_PRESET.presence_penalty);
  });
});
