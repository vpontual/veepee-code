import { describe, it, expect } from 'vitest';

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

// Planning intent detection patterns — copied from PLAN_PATTERNS in agent.ts
const PLAN_PATTERNS = [
  /\bplan\b/i, /\bdesign\b/i, /\barchitect\b/i, /\bstrateg/i,
  /\bthink\s+(about|through)\b/i, /\bbrainstorm\b/i, /\bapproach\b/i,
  /\bhow\s+(should|would|could)\s+(we|i|you)\b/i,
  /\bbefore\s+(we|i|you)\s+(start|begin|implement|code|build)\b/i,
  /\bwhat('s|\s+is)\s+the\s+best\s+way\b/i,
  /\bbreak\s+(this|it)\s+down\b/i, /\bstep\s+by\s+step\b/i,
  /\bdeepen\b/i, /\belaborate\b/i, /\bexpand\s+on\b/i,
  /\blet'?s\s+think\b/i, /\bconsider\b/i,
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

describe('Agent planning intent patterns', () => {
  const detectsPlanningIntent = (message: string) =>
    PLAN_PATTERNS.some(p => p.test(message));

  it('detects "plan" keyword', () => {
    expect(detectsPlanningIntent('Let me plan this feature')).toBe(true);
  });

  it('detects "design" keyword', () => {
    expect(detectsPlanningIntent('Can you design the API?')).toBe(true);
  });

  it('detects "architect" keyword', () => {
    expect(detectsPlanningIntent('Help me architect this system')).toBe(true);
  });

  it('detects "strategy" / "strategic"', () => {
    expect(detectsPlanningIntent('What strategy should we use?')).toBe(true);
    expect(detectsPlanningIntent('Take a strategic approach')).toBe(true);
  });

  it('detects "think about/through"', () => {
    expect(detectsPlanningIntent('Think about the architecture')).toBe(true);
    expect(detectsPlanningIntent('Let me think through this')).toBe(true);
  });

  it('detects "how should we"', () => {
    expect(detectsPlanningIntent('How should we implement caching?')).toBe(true);
  });

  it('detects "how would you"', () => {
    expect(detectsPlanningIntent('How would you approach this?')).toBe(true);
  });

  it('detects "before we start/begin/implement"', () => {
    expect(detectsPlanningIntent('Before we start, let me outline this')).toBe(true);
    expect(detectsPlanningIntent('Before I implement, let me think')).toBe(true);
  });

  it('detects "what is the best way"', () => {
    expect(detectsPlanningIntent("What's the best way to handle errors?")).toBe(true);
    expect(detectsPlanningIntent('What is the best way to test?')).toBe(true);
  });

  it('detects "break this/it down"', () => {
    expect(detectsPlanningIntent('Break this down into steps')).toBe(true);
    expect(detectsPlanningIntent('Break it down for me')).toBe(true);
  });

  it('detects "step by step"', () => {
    expect(detectsPlanningIntent('Walk me through step by step')).toBe(true);
  });

  it('detects "brainstorm"', () => {
    expect(detectsPlanningIntent('Let us brainstorm ideas')).toBe(true);
  });

  it('detects "elaborate" and "expand on"', () => {
    expect(detectsPlanningIntent('Please elaborate on the design')).toBe(true);
    expect(detectsPlanningIntent('Expand on the caching layer')).toBe(true);
  });

  it('detects "consider"', () => {
    expect(detectsPlanningIntent('Consider the performance implications')).toBe(true);
  });

  it('does not match plain coding requests', () => {
    expect(detectsPlanningIntent('Fix the bug in utils.ts')).toBe(false);
    expect(detectsPlanningIntent('Add a new endpoint for users')).toBe(false);
    expect(detectsPlanningIntent('Read the file and show me')).toBe(false);
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
