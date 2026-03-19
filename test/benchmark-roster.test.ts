import { describe, it, expect } from 'vitest';
import { Benchmarker, type BenchmarkResult } from '../src/benchmark.js';

function makeResult(overrides: Partial<BenchmarkResult> & { model: string }): BenchmarkResult {
  return {
    tier: 'standard',
    parameterSize: '8B',
    scores: {
      toolCalling: 70,
      codeGeneration: 70,
      codeEditing: 70,
      instructionFollowing: 70,
      reasoning: 70,
    },
    performance: {
      avgLatencyMs: 1000,
      tokensPerSecond: 10,
      timeToFirstToken: 200,
    },
    context: { optimalSize: 8192, maxUsable: 32768, speedByContext: {} },
    overall: 70,
    timestamp: new Date().toISOString(),
    errors: [],
    ...overrides,
  };
}

describe('Benchmarker.buildRoster', () => {
  it('returns null roster for empty results', () => {
    const roster = Benchmarker.buildRoster([]);
    expect(roster.act).toBeNull();
    expect(roster.plan).toBeNull();
  });

  it('assigns best overall to act', () => {
    const results = [
      makeResult({ model: 'fast-model', overall: 90, performance: { avgLatencyMs: 500, tokensPerSecond: 20, timeToFirstToken: 100 } }),
      makeResult({ model: 'slow-model', overall: 95, performance: { avgLatencyMs: 5000, tokensPerSecond: 1, timeToFirstToken: 3000 } }),
    ];
    const roster = Benchmarker.buildRoster(results);
    expect(roster.act).toBe('fast-model'); // best overall with >= 2 tok/s
  });

  it('assigns best reasoning to plan', () => {
    const results = [
      makeResult({ model: 'coder', overall: 90, scores: { toolCalling: 90, codeGeneration: 95, codeEditing: 90, instructionFollowing: 80, reasoning: 60 } }),
      makeResult({ model: 'thinker', overall: 80, scores: { toolCalling: 70, codeGeneration: 70, codeEditing: 70, instructionFollowing: 70, reasoning: 95 } }),
    ];
    const roster = Benchmarker.buildRoster(results);
    expect(roster.plan).toBe('thinker');
  });

  it('assigns fastest with good instruction following to chat', () => {
    const results = [
      makeResult({ model: 'slow-good', performance: { avgLatencyMs: 2000, tokensPerSecond: 5, timeToFirstToken: 500 }, scores: { toolCalling: 70, codeGeneration: 70, codeEditing: 70, instructionFollowing: 90, reasoning: 70 } }),
      makeResult({ model: 'fast-ok', performance: { avgLatencyMs: 200, tokensPerSecond: 40, timeToFirstToken: 50 }, scores: { toolCalling: 70, codeGeneration: 70, codeEditing: 70, instructionFollowing: 70, reasoning: 70 } }),
    ];
    const roster = Benchmarker.buildRoster(results);
    expect(roster.chat).toBe('fast-ok'); // speed * 5 + instruction following
  });

  it('assigns best code gen + editing to code', () => {
    const results = [
      makeResult({ model: 'generalist', scores: { toolCalling: 80, codeGeneration: 70, codeEditing: 70, instructionFollowing: 80, reasoning: 80 } }),
      makeResult({ model: 'coder', scores: { toolCalling: 60, codeGeneration: 95, codeEditing: 90, instructionFollowing: 60, reasoning: 60 } }),
    ];
    const roster = Benchmarker.buildRoster(results);
    expect(roster.code).toBe('coder');
  });

  it('assigns fastest with tool calling to search', () => {
    const results = [
      makeResult({ model: 'big', performance: { avgLatencyMs: 2000, tokensPerSecond: 5, timeToFirstToken: 500 }, scores: { toolCalling: 95, codeGeneration: 90, codeEditing: 90, instructionFollowing: 90, reasoning: 90 } }),
      makeResult({ model: 'small-fast', performance: { avgLatencyMs: 100, tokensPerSecond: 50, timeToFirstToken: 30 }, scores: { toolCalling: 70, codeGeneration: 50, codeEditing: 50, instructionFollowing: 60, reasoning: 50 } }),
    ];
    const roster = Benchmarker.buildRoster(results);
    expect(roster.search).toBe('small-fast'); // speed * 8 + tool calling
  });

  it('falls back to act model for all roles with single model', () => {
    const results = [makeResult({ model: 'only-model', overall: 80 })];
    const roster = Benchmarker.buildRoster(results);
    expect(roster.act).toBe('only-model');
    expect(roster.plan).toBe('only-model');
    expect(roster.chat).toBe('only-model');
    expect(roster.code).toBe('only-model');
    expect(roster.search).toBe('only-model');
  });
});
