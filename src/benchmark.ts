import { Ollama } from 'ollama';
import chalk from 'chalk';
import { writeFile, readFile, mkdir } from 'fs/promises';
import { resolve } from 'path';
import { existsSync } from 'fs';
import type { ModelProfile } from './models.js';

// ─── Types ───────────────────────────────────────────────────────────────────

/** Model roster — best model for each role, determined by benchmark */
export interface ModelRoster {
  act: string | null;     // best balanced for coding (overall score + speed)
  plan: string | null;    // best reasoning (highest reasoning score, can be slower)
  chat: string | null;    // fastest with good instruction following
  code: string | null;    // best code generation + editing
  search: string | null;  // fastest with tool calling (for sub-agents)
}

export interface BenchmarkResult {
  model: string;
  tier: string;
  parameterSize: string;
  scores: {
    toolCalling: number;      // 0-100: can it correctly invoke tools?
    codeGeneration: number;   // 0-100: does it write correct code?
    codeEditing: number;      // 0-100: precise string replacement?
    instructionFollowing: number; // 0-100: does it follow instructions?
    reasoning: number;        // 0-100: multi-step logic
  };
  performance: {
    avgLatencyMs: number;     // average response time
    tokensPerSecond: number;  // generation speed
    timeToFirstToken: number; // cold start indicator
  };
  context: {
    optimalSize: number;      // best context size (tokens) balancing quality + speed
    maxUsable: number;        // largest context that still produces correct output
    speedByContext: Record<number, number>; // context_size → tok/s
  };
  overall: number;            // weighted composite 0-100
  timestamp: string;
  errors: string[];
}

interface TestCase {
  name: string;
  category: keyof BenchmarkResult['scores'];
  weight: number;
  prompt: string;
  tools?: unknown[];
  validate: (response: string, toolCalls?: ToolCallResult[]) => { pass: boolean; score: number; reason: string };
}

interface ToolCallResult {
  name: string;
  args: Record<string, unknown>;
}

// ─── Test Suite ──────────────────────────────────────────────────────────────

const TEST_SUITE: TestCase[] = [
  // Tool Calling Tests
  {
    name: 'Simple tool call',
    category: 'toolCalling',
    weight: 1,
    prompt: 'Read the file at /etc/hostname',
    tools: [{
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read a file from the filesystem',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path to read' },
          },
          required: ['path'],
        },
      },
    }],
    validate: (_response, toolCalls) => {
      if (!toolCalls || toolCalls.length === 0) {
        return { pass: false, score: 0, reason: 'No tool call made' };
      }
      const call = toolCalls[0];
      if (call.name !== 'read_file') {
        return { pass: false, score: 20, reason: `Wrong tool: ${call.name}` };
      }
      if (!call.args.path || !(call.args.path as string).includes('hostname')) {
        return { pass: false, score: 50, reason: `Wrong path: ${JSON.stringify(call.args)}` };
      }
      return { pass: true, score: 100, reason: 'Correct tool and args' };
    },
  },
  {
    name: 'Multi-arg tool call',
    category: 'toolCalling',
    weight: 1,
    prompt: 'Search for all TypeScript files containing "interface" in the src directory',
    tools: [{
      type: 'function',
      function: {
        name: 'grep',
        description: 'Search file contents using a regex pattern',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'Regex pattern' },
            path: { type: 'string', description: 'Directory to search' },
            include: { type: 'string', description: 'File pattern (e.g. "*.ts")' },
          },
          required: ['pattern'],
        },
      },
    }],
    validate: (_response, toolCalls) => {
      if (!toolCalls || toolCalls.length === 0) {
        return { pass: false, score: 0, reason: 'No tool call' };
      }
      const call = toolCalls[0];
      if (call.name !== 'grep') return { pass: false, score: 10, reason: `Wrong tool: ${call.name}` };

      let score = 30; // base for calling right tool
      if (call.args.pattern && String(call.args.pattern).includes('interface')) score += 30;
      if (call.args.include && String(call.args.include).includes('ts')) score += 20;
      if (call.args.path && String(call.args.path).includes('src')) score += 20;

      return { pass: score >= 80, score, reason: `Args: ${JSON.stringify(call.args)}` };
    },
  },
  {
    name: 'Tool selection (multiple available)',
    category: 'toolCalling',
    weight: 1.5,
    prompt: 'List all .json files in the current directory',
    tools: [
      {
        type: 'function',
        function: {
          name: 'read_file',
          description: 'Read a file from the filesystem',
          parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        },
      },
      {
        type: 'function',
        function: {
          name: 'glob',
          description: 'Find files matching a glob pattern',
          parameters: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] },
        },
      },
      {
        type: 'function',
        function: {
          name: 'bash',
          description: 'Execute a shell command',
          parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
        },
      },
    ],
    validate: (_response, toolCalls) => {
      if (!toolCalls || toolCalls.length === 0) {
        return { pass: false, score: 0, reason: 'No tool call' };
      }
      const call = toolCalls[0];
      // glob is the best choice, bash is acceptable
      if (call.name === 'glob') {
        const pattern = String(call.args.pattern || '');
        if (pattern.includes('.json') || pattern.includes('*.json')) {
          return { pass: true, score: 100, reason: 'Correctly chose glob with json pattern' };
        }
        return { pass: true, score: 70, reason: `Chose glob but pattern: ${pattern}` };
      }
      if (call.name === 'bash') {
        return { pass: true, score: 60, reason: 'Used bash instead of glob (works but suboptimal)' };
      }
      return { pass: false, score: 10, reason: `Wrong tool choice: ${call.name}` };
    },
  },

  // Code Generation Tests
  {
    name: 'Simple function',
    category: 'codeGeneration',
    weight: 1,
    prompt: 'Write a JavaScript function called `isPrime` that takes a number and returns true if it is prime, false otherwise. Return ONLY the function code, no explanation.',
    validate: (response) => {
      let score = 0;
      const lower = response.toLowerCase();
      if (lower.includes('function') || lower.includes('=>')) score += 20;
      if (lower.includes('isprime')) score += 20;
      if (lower.includes('return') && (lower.includes('true') || lower.includes('false'))) score += 20;
      // Check for loop logic
      if (lower.includes('for') || lower.includes('while') || lower.includes('sqrt') || lower.includes('math')) score += 20;
      // Check for edge cases (0, 1, 2, negative)
      if (lower.includes('<= 1') || lower.includes('< 2') || lower.includes('=== 1') || lower.includes('=== 0')) score += 20;
      return { pass: score >= 80, score, reason: `Code quality: ${score}/100` };
    },
  },
  {
    name: 'TypeScript with types',
    category: 'codeGeneration',
    weight: 1,
    prompt: 'Write a TypeScript interface called `User` with fields: id (number), name (string), email (string), createdAt (Date), optional roles (string array). Then write a function `createUser` that takes name and email and returns a User. Return ONLY code.',
    validate: (response) => {
      let score = 0;
      if (response.includes('interface') && response.includes('User')) score += 20;
      if (response.includes('id') && response.includes('number')) score += 10;
      if (response.includes('name') && response.includes('string')) score += 10;
      if (response.includes('email')) score += 10;
      if (response.includes('Date') || response.includes('createdAt')) score += 10;
      if (response.includes('roles') && (response.includes('?') || response.includes('optional'))) score += 10;
      if (response.includes('createUser') || response.includes('create_user')) score += 15;
      if (response.includes('function') || response.includes('=>')) score += 15;
      return { pass: score >= 70, score, reason: `TypeScript quality: ${score}/100` };
    },
  },
  {
    name: 'Bug fix',
    category: 'codeGeneration',
    weight: 1.5,
    prompt: `Fix the bug in this function:\n\n\`\`\`javascript\nfunction flatten(arr) {\n  let result = [];\n  for (let i = 0; i < arr.length; i++) {\n    if (Array.isArray(arr[i])) {\n      result.push(flatten(arr[i]));\n    } else {\n      result.push(arr[i]);\n    }\n  }\n  return result;\n}\n\`\`\`\n\nThe function should flatten nested arrays like [1, [2, [3]]] into [1, 2, 3]. What is the bug and how to fix it?`,
    validate: (response) => {
      let score = 0;
      const lower = response.toLowerCase();
      // Should identify push vs concat/spread issue
      if (lower.includes('concat') || lower.includes('spread') || lower.includes('...') || lower.includes('push(') && lower.includes('flatten')) score += 40;
      // Should explain the bug
      if (lower.includes('push') && (lower.includes('instead') || lower.includes('should') || lower.includes('replace') || lower.includes('nested'))) score += 30;
      // Should provide corrected code
      if (response.includes('concat(') || response.includes('...flatten') || response.includes('push(...')) score += 30;
      return { pass: score >= 60, score, reason: `Bug analysis: ${score}/100` };
    },
  },

  // Code Editing Tests
  {
    name: 'Exact string replacement',
    category: 'codeEditing',
    weight: 1.5,
    prompt: `I have this code:\n\n\`\`\`\nconst greeting = "hello";\nconsole.log(greeting);\n\`\`\`\n\nChange "hello" to "world". Give me the EXACT old string and new string for a find-and-replace operation. Format your answer as:\nOLD: <exact old string>\nNEW: <exact new string>`,
    validate: (response) => {
      let score = 0;
      // Check for exact string identification
      if (response.includes('"hello"') || response.includes("'hello'") || response.includes('`hello`')) score += 50;
      if (response.includes('"world"') || response.includes("'world'") || response.includes('`world`')) score += 50;
      return { pass: score >= 80, score, reason: `Edit precision: ${score}/100` };
    },
  },

  // Instruction Following Tests
  {
    name: 'Format constraint',
    category: 'instructionFollowing',
    weight: 1,
    prompt: 'List exactly 3 programming languages. Format: one per line, numbered 1-3. No explanations, no extra text, just the numbered list.',
    validate: (response) => {
      const lines = response.trim().split('\n').filter(l => l.trim());
      let score = 0;

      // Should have exactly 3 lines
      if (lines.length === 3) score += 40;
      else if (lines.length >= 2 && lines.length <= 4) score += 20;

      // Should be numbered
      const numbered = lines.filter(l => /^\d/.test(l.trim()));
      score += Math.min(numbered.length, 3) * 10;

      // Should not have long explanations
      const avgLen = lines.reduce((s, l) => s + l.length, 0) / Math.max(lines.length, 1);
      if (avgLen < 40) score += 30;

      return { pass: score >= 70, score, reason: `Format adherence: ${score}/100` };
    },
  },
  {
    name: 'Conciseness',
    category: 'instructionFollowing',
    weight: 1,
    prompt: 'What is 2 + 2? Answer with ONLY the number, nothing else.',
    validate: (response) => {
      const trimmed = response.trim();
      if (trimmed === '4') return { pass: true, score: 100, reason: 'Perfect concise answer' };
      if (trimmed.includes('4') && trimmed.length < 10) return { pass: true, score: 80, reason: 'Correct but slightly verbose' };
      if (trimmed.includes('4')) return { pass: true, score: 50, reason: 'Correct but too verbose' };
      return { pass: false, score: 0, reason: `Wrong or no answer: "${trimmed.slice(0, 50)}"` };
    },
  },

  // Reasoning Tests
  {
    name: 'Multi-step logic',
    category: 'reasoning',
    weight: 1,
    prompt: 'A function receives an array of numbers. It should return the second largest unique number. What should it return for [5, 3, 5, 8, 3, 8, 1]? Show your reasoning step by step, then give the final answer.',
    validate: (response) => {
      let score = 0;
      const lower = response.toLowerCase();

      // Should mention deduplication/unique
      if (lower.includes('unique') || lower.includes('deduplic') || lower.includes('distinct') || lower.includes('set')) score += 20;

      // Should mention sorting or comparison
      if (lower.includes('sort') || lower.includes('largest') || lower.includes('second')) score += 20;

      // Should identify unique values as [1, 3, 5, 8]
      if (response.includes('1') && response.includes('3') && response.includes('5') && response.includes('8')) score += 20;

      // Correct answer is 5
      if (response.includes('5') && (lower.includes('answer') || lower.includes('result') || lower.includes('return') || lower.includes('second largest'))) score += 40;

      return { pass: score >= 60, score, reason: `Reasoning: ${score}/100` };
    },
  },
  {
    name: 'Edge case awareness',
    category: 'reasoning',
    weight: 1,
    prompt: 'I want to write a function that divides two numbers. What edge cases should I handle? List them briefly.',
    validate: (response) => {
      let score = 0;
      const lower = response.toLowerCase();

      if (lower.includes('zero') || lower.includes('divide by 0') || lower.includes('division by zero')) score += 35;
      if (lower.includes('nan') || lower.includes('not a number') || lower.includes('type') || lower.includes('invalid')) score += 20;
      if (lower.includes('infinity') || lower.includes('overflow') || lower.includes('large')) score += 15;
      if (lower.includes('negative') || lower.includes('float') || lower.includes('decimal') || lower.includes('precision')) score += 15;
      if (lower.includes('null') || lower.includes('undefined') || lower.includes('none') || lower.includes('missing')) score += 15;

      return { pass: score >= 50, score, reason: `Edge cases: ${score}/100` };
    },
  },
];

// ─── Benchmark Runner ────────────────────────────────────────────────────────

export class Benchmarker {
  private ollama: Ollama;
  private resultsDir: string;

  constructor(proxyUrl: string) {
    this.ollama = new Ollama({ host: proxyUrl });
    this.resultsDir = resolve(process.env.HOME || '~', '.veepee-code', 'benchmarks');
  }

  /** Run full benchmark suite against a single model */
  async benchmarkModel(model: ModelProfile, onProgress?: (test: string, idx: number, total: number) => void): Promise<BenchmarkResult> {
    const errors: string[] = [];
    const categoryScores: Record<string, { total: number; weight: number }> = {
      toolCalling: { total: 0, weight: 0 },
      codeGeneration: { total: 0, weight: 0 },
      codeEditing: { total: 0, weight: 0 },
      instructionFollowing: { total: 0, weight: 0 },
      reasoning: { total: 0, weight: 0 },
    };

    let totalLatency = 0;
    let totalTokens = 0;
    let totalTime = 0;
    let firstTokenTotal = 0;
    let testCount = 0;

    for (let i = 0; i < TEST_SUITE.length; i++) {
      const test = TEST_SUITE[i];
      onProgress?.(test.name, i + 1, TEST_SUITE.length);

      try {
        const startTime = Date.now();
        let firstTokenTime = 0;
        let responseText = '';
        let toolCalls: ToolCallResult[] = [];
        let tokenCount = 0;

        const stream = await this.ollama.chat({
          model: model.name,
          messages: [{ role: 'user', content: test.prompt }],
          tools: test.tools as never,
          stream: true,
          keep_alive: '30m',
          options: {
            num_predict: 512,
            temperature: 0.1, // low temp for reproducibility
          },
        });

        for await (const chunk of stream) {
          if (firstTokenTime === 0 && (chunk.message.content || chunk.message.tool_calls)) {
            firstTokenTime = Date.now() - startTime;
          }
          if (chunk.message.content) {
            responseText += chunk.message.content;
            tokenCount++;
          }
          if (chunk.message.tool_calls) {
            toolCalls = chunk.message.tool_calls.map(tc => ({
              name: tc.function.name,
              args: (tc.function.arguments || {}) as Record<string, unknown>,
            }));
          }
        }

        const elapsed = Date.now() - startTime;
        totalLatency += elapsed;
        totalTokens += tokenCount;
        totalTime += elapsed;
        firstTokenTotal += firstTokenTime;
        testCount++;

        // Validate
        const result = test.validate(responseText, toolCalls);
        categoryScores[test.category].total += result.score * test.weight;
        categoryScores[test.category].weight += test.weight;

        if (!result.pass) {
          errors.push(`${test.name}: ${result.reason}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${test.name}: FAILED - ${msg}`);
        categoryScores[test.category].weight += test.weight;
        testCount++;
        totalLatency += 30000; // penalty
      }
    }

    // Compute category scores
    const scores = {
      toolCalling: categoryScores.toolCalling.weight > 0
        ? Math.round(categoryScores.toolCalling.total / categoryScores.toolCalling.weight) : 0,
      codeGeneration: categoryScores.codeGeneration.weight > 0
        ? Math.round(categoryScores.codeGeneration.total / categoryScores.codeGeneration.weight) : 0,
      codeEditing: categoryScores.codeEditing.weight > 0
        ? Math.round(categoryScores.codeEditing.total / categoryScores.codeEditing.weight) : 0,
      instructionFollowing: categoryScores.instructionFollowing.weight > 0
        ? Math.round(categoryScores.instructionFollowing.total / categoryScores.instructionFollowing.weight) : 0,
      reasoning: categoryScores.reasoning.weight > 0
        ? Math.round(categoryScores.reasoning.total / categoryScores.reasoning.weight) : 0,
    };

    // Weighted overall (tool calling and code gen weighted higher for a coding CLI)
    const overall = Math.round(
      scores.toolCalling * 0.30 +
      scores.codeGeneration * 0.25 +
      scores.codeEditing * 0.15 +
      scores.instructionFollowing * 0.15 +
      scores.reasoning * 0.15
    );

    const performance = {
      avgLatencyMs: testCount > 0 ? Math.round(totalLatency / testCount) : 0,
      tokensPerSecond: totalTime > 0 ? Math.round((totalTokens / totalTime) * 1000) : 0,
      timeToFirstToken: testCount > 0 ? Math.round(firstTokenTotal / testCount) : 0,
    };

    // Context size probing
    onProgress?.('Context probing', TEST_SUITE.length + 1, TEST_SUITE.length + 1);
    const context = await this.probeContextSizes(model.name);

    return {
      model: model.name,
      tier: model.tier,
      parameterSize: model.parameterSize,
      scores,
      performance,
      context,
      overall,
      timestamp: new Date().toISOString(),
      errors,
    };
  }

  /**
   * Probe optimal context size by testing at increasing sizes.
   * Sends a prompt with padding to fill context, checks quality + speed.
   * The "optimal" size balances quality (correct output) with speed (tok/s).
   */
  private async probeContextSizes(modelName: string): Promise<BenchmarkResult['context']> {
    const sizes = [2048, 4096, 8192, 16384, 32768, 65536, 131072];
    const speedByContext: Record<number, number> = {};
    let maxUsable = 2048;
    let optimalSize = 4096;
    let bestEfficiency = 0; // score * speed

    // Reference question that requires precise reasoning
    const probe = 'What is the sum of the first 10 prime numbers? Answer with ONLY the number.';
    const expectedAnswer = '129'; // 2+3+5+7+11+13+17+19+23+29

    for (const ctxSize of sizes) {
      try {
        // Build padding to fill ~60% of context (simulates real conversation history)
        const paddingTokens = Math.floor(ctxSize * 0.6);
        const padding = generateContextPadding(paddingTokens);

        const startTime = Date.now();
        let responseText = '';
        let tokenCount = 0;

        const stream = await this.ollama.chat({
          model: modelName,
          messages: [
            { role: 'system', content: 'You are a helpful assistant. Answer concisely.' },
            { role: 'user', content: padding },
            { role: 'assistant', content: 'I understand. I\'ve reviewed the information above.' },
            { role: 'user', content: probe },
          ],
          stream: true,
          keep_alive: '30m',
          options: {
            num_ctx: ctxSize,
            num_predict: 64,
            temperature: 0.0,
          },
        });

        for await (const chunk of stream) {
          if (chunk.message.content) {
            responseText += chunk.message.content;
            tokenCount++;
          }
        }

        const elapsed = Date.now() - startTime;
        const tps = elapsed > 0 ? Math.round((tokenCount / elapsed) * 1000) : 0;
        speedByContext[ctxSize] = tps;

        // Check if answer is correct
        const isCorrect = responseText.includes(expectedAnswer);

        if (isCorrect || responseText.trim().length > 0) {
          maxUsable = ctxSize;

          // Efficiency = correctness bonus * speed
          // We want the largest context where quality is still good AND speed is acceptable
          const qualityBonus = isCorrect ? 2.0 : 0.5;
          const efficiency = qualityBonus * tps;

          if (efficiency > bestEfficiency) {
            bestEfficiency = efficiency;
            optimalSize = ctxSize;
          }
        }
      } catch {
        // Model can't handle this context size — stop probing larger
        break;
      }
    }

    return { optimalSize, maxUsable, speedByContext };
  }

  /** Run benchmarks against all models (or a filtered set) */
  async benchmarkAll(
    models: ModelProfile[],
    options: { filter?: 'heavy' | 'standard' | 'light'; maxModels?: number; onProgress?: (model: string, test: string, modelIdx: number, totalModels: number, testIdx: number, totalTests: number) => void } = {},
  ): Promise<BenchmarkResult[]> {
    let candidates = models
      .filter(m => !m.capabilities.includes('embedding') || m.capabilities.length > 1); // skip embedding-only

    if (options.filter) {
      candidates = candidates.filter(m => m.tier === options.filter);
    }

    if (options.maxModels) {
      candidates = candidates.slice(0, options.maxModels);
    }

    const results: BenchmarkResult[] = [];

    for (let mi = 0; mi < candidates.length; mi++) {
      const model = candidates[mi];
      const result = await this.benchmarkModel(model, (test, testIdx, totalTests) => {
        options.onProgress?.(model.name, test, mi + 1, candidates.length, testIdx, totalTests);
      });
      results.push(result);
    }

    // Sort by overall score descending
    results.sort((a, b) => b.overall - a.overall);

    // Save results
    await this.saveResults(results);

    return results;
  }

  /**
   * Smart first-launch benchmark:
   * 1. Take all models with tool support (skip embedding-only)
   * 2. Quick responsiveness check — send "hi", measure TTFT. Skip models > 10s
   * 3. Full benchmark survivors
   * 4. Build model roster (best per role)
   */
  async smartBenchmark(
    allModels: ModelProfile[],
    onProgress?: (phase: string, detail: string) => void,
  ): Promise<{ results: BenchmarkResult[]; roster: ModelRoster }> {
    // Phase 1: Filter candidates
    const candidates = allModels.filter(m =>
      !m.capabilities.includes('embedding') || m.capabilities.length > 1
    ).filter(m =>
      m.capabilities.includes('tools')
    );

    onProgress?.('filter', `${candidates.length} models with tool support out of ${allModels.length} total`);

    // Phase 2: Speed check — send a prompt, allow up to 60s for model loading,
    // then measure GENERATION SPEED (tok/s). Cold start doesn't matter —
    // models only load once per session. What matters is how fast they generate.
    const responsive: ModelProfile[] = [];
    for (const model of candidates) {
      onProgress?.('speed-check', `Testing ${model.name} (${model.parameterSize})...`);

      try {
        const start = Date.now();
        let ttft = 0;
        let tokenCount = 0;
        let genStart = 0;

        const stream = await this.ollama.chat({
          model: model.name,
          messages: [{ role: 'user', content: 'Count from 1 to 10, one number per line.' }],
          stream: true,
          keep_alive: '30m',
          options: { num_predict: 50, temperature: 0 },
        });

        for await (const chunk of stream) {
          if (chunk.message.content) {
            if (ttft === 0) {
              ttft = Date.now() - start;
              genStart = Date.now();
            }
            tokenCount++;
          }
          // Abort if model takes >60s to start generating (truly broken/huge)
          if (ttft === 0 && Date.now() - start > 60000) break;
        }

        const genTime = genStart > 0 ? Date.now() - genStart : 0;
        const tokPerSec = genTime > 0 ? Math.round((tokenCount / genTime) * 1000) : 0;
        const loadTime = ttft > 0 ? (ttft / 1000).toFixed(1) : 'timeout';

        if (tokPerSec >= 1) {
          responsive.push(model);
          onProgress?.('speed-check', `  ✓ ${model.name}: ${tokPerSec} tok/s (${loadTime}s load) — usable`);
        } else {
          onProgress?.('speed-check', `  ✗ ${model.name}: ${tokPerSec} tok/s (${loadTime}s load) — too slow`);
        }
      } catch {
        onProgress?.('speed-check', `  ✗ ${model.name}: failed to respond`);
      }
    }

    onProgress?.('speed-check', `${responsive.length}/${candidates.length} models passed speed check`);

    if (responsive.length === 0) {
      return { results: [], roster: { act: null, plan: null, chat: null, code: null, search: null } };
    }

    // Phase 3: Full benchmark on responsive models
    onProgress?.('benchmark', `Running full benchmark on ${responsive.length} models...`);

    const results: BenchmarkResult[] = [];
    for (let mi = 0; mi < responsive.length; mi++) {
      const model = responsive[mi];
      const result = await this.benchmarkModel(model, (test, testIdx, totalTests) => {
        onProgress?.('benchmark', `[${mi + 1}/${responsive.length}] ${model.name} — ${test} (${testIdx}/${totalTests})`);
      });
      results.push(result);
    }

    results.sort((a, b) => b.overall - a.overall);
    await this.saveResults(results);

    // Phase 4: Build roster
    const roster = Benchmarker.buildRoster(results);
    await this.saveRoster(roster);

    onProgress?.('done', `Benchmark complete. Roster: act=${roster.act}, plan=${roster.plan}, chat=${roster.chat}, code=${roster.code}`);

    return { results, roster };
  }

  /** Build optimal model roster from benchmark results */
  static buildRoster(results: BenchmarkResult[]): ModelRoster {
    if (results.length === 0) {
      return { act: null, plan: null, chat: null, code: null, search: null };
    }

    // Act: best overall score with decent speed (>2 tok/s)
    const act = results.find(r => r.performance.tokensPerSecond >= 2)?.model
      || results[0].model;

    // Plan: best reasoning score (can be slower — >1 tok/s is fine)
    const plan = [...results]
      .filter(r => r.performance.tokensPerSecond >= 1)
      .sort((a, b) => b.scores.reasoning - a.scores.reasoning)[0]?.model
      || act;

    // Chat: fastest model with good instruction following (>5 tok/s preferred)
    const chat = [...results]
      .filter(r => r.performance.tokensPerSecond >= 3)
      .sort((a, b) => {
        // Weight speed heavily for chat
        const aScore = a.scores.instructionFollowing + a.performance.tokensPerSecond * 5;
        const bScore = b.scores.instructionFollowing + b.performance.tokensPerSecond * 5;
        return bScore - aScore;
      })[0]?.model
      || act;

    // Code: best code generation + editing combined
    const code = [...results]
      .filter(r => r.performance.tokensPerSecond >= 2)
      .sort((a, b) => {
        const aScore = a.scores.codeGeneration * 0.6 + a.scores.codeEditing * 0.4;
        const bScore = b.scores.codeGeneration * 0.6 + b.scores.codeEditing * 0.4;
        return bScore - aScore;
      })[0]?.model
      || act;

    // Search (sub-agent): fastest with good tool calling
    const search = [...results]
      .filter(r => r.performance.tokensPerSecond >= 3)
      .sort((a, b) => {
        // Weight speed heavily + tool calling
        const aScore = a.scores.toolCalling + a.performance.tokensPerSecond * 8;
        const bScore = b.scores.toolCalling + b.performance.tokensPerSecond * 8;
        return bScore - aScore;
      })[0]?.model
      || act;

    return { act, plan, chat, code, search };
  }

  /** Save roster to disk */
  private async saveRoster(roster: ModelRoster): Promise<void> {
    await mkdir(this.resultsDir, { recursive: true });
    const rosterPath = resolve(this.resultsDir, 'roster.json');
    await writeFile(rosterPath, JSON.stringify(roster, null, 2));
  }

  /** Load saved roster */
  async loadRoster(): Promise<ModelRoster | null> {
    const rosterPath = resolve(this.resultsDir, 'roster.json');
    if (!existsSync(rosterPath)) return null;
    try {
      const data = await readFile(rosterPath, 'utf-8');
      return JSON.parse(data) as ModelRoster;
    } catch {
      return null;
    }
  }

  /** Format roster for display */
  static formatRoster(roster: ModelRoster): string {
    const lines: string[] = ['', chalk.bold('  Model Roster (auto-selected from benchmarks)'), ''];
    const roles: Array<[string, string, keyof ModelRoster]> = [
      ['Act (default)', 'Best balanced for coding', 'act'],
      ['Plan', 'Best reasoning (thinking mode)', 'plan'],
      ['Chat', 'Fastest conversational', 'chat'],
      ['Code', 'Best code gen + editing', 'code'],
      ['Search', 'Fastest for sub-agents', 'search'],
    ];
    for (const [label, desc, key] of roles) {
      const model = roster[key] || '(none)';
      lines.push(`  ${chalk.cyan(label.padEnd(16))} ${chalk.white(model.padEnd(30))} ${chalk.dim(desc)}`);
    }
    lines.push('');
    return lines.join('\n');
  }

  /** Save benchmark results to disk */
  async saveResults(results: BenchmarkResult[]): Promise<string> {
    await mkdir(this.resultsDir, { recursive: true });
    const filename = `benchmark-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    const filepath = resolve(this.resultsDir, filename);
    await writeFile(filepath, JSON.stringify(results, null, 2));

    // Also save as latest
    const latestPath = resolve(this.resultsDir, 'latest.json');
    await writeFile(latestPath, JSON.stringify(results, null, 2));

    return filepath;
  }

  /** Load the most recent benchmark results */
  async loadLatest(): Promise<BenchmarkResult[] | null> {
    const latestPath = resolve(this.resultsDir, 'latest.json');
    if (!existsSync(latestPath)) return null;

    try {
      const data = await readFile(latestPath, 'utf-8');
      return JSON.parse(data) as BenchmarkResult[];
    } catch {
      return null;
    }
  }

  /** Format results as a terminal table */
  static formatTable(results: BenchmarkResult[]): string {
    if (results.length === 0) return '  No benchmark results available.';

    const lines: string[] = [''];

    // Header
    const header = [
      chalk.bold('Rank'),
      chalk.bold('Model'.padEnd(30)),
      chalk.bold('Size'.padEnd(7)),
      chalk.bold('Overall'),
      chalk.bold('Tools'),
      chalk.bold('CodeGen'),
      chalk.bold('Edit'),
      chalk.bold('Follow'),
      chalk.bold('Reason'),
      chalk.bold('tok/s'),
      chalk.bold('TTFT'),
      chalk.bold('Ctx'),
    ];
    lines.push('  ' + header.join('  '));
    lines.push('  ' + '─'.repeat(130));

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const rank = String(i + 1).padStart(4);
      const name = r.model.padEnd(30).slice(0, 30);
      const size = r.parameterSize.padEnd(7);
      const overall = colorScore(r.overall).padStart(5);
      const tools = colorScore(r.scores.toolCalling).padStart(5);
      const codegen = colorScore(r.scores.codeGeneration).padStart(5);
      const edit = colorScore(r.scores.codeEditing).padStart(5);
      const follow = colorScore(r.scores.instructionFollowing).padStart(5);
      const reason = colorScore(r.scores.reasoning).padStart(5);
      const tps = String(r.performance.tokensPerSecond).padStart(5);
      const ttft = (r.performance.timeToFirstToken + 'ms').padStart(7);
      const ctx = r.context ? formatCtxSize(r.context.optimalSize).padStart(5) : chalk.dim('  n/a');

      lines.push(`  ${rank}  ${name}  ${size}  ${overall}  ${tools}  ${codegen}  ${edit}  ${follow}  ${reason}  ${tps}  ${ttft}  ${ctx}`);
    }

    lines.push('');
    lines.push(chalk.dim('  Scores: 0-100 (higher is better) | tok/s: tokens per second | TTFT: time to first token'));
    lines.push(chalk.dim(`  Ctx: optimal context window (auto-detected) | Weights: Tools 30% | CodeGen 25% | Edit+Follow+Reason 15% each`));
    lines.push(chalk.dim(`  Run: ${results[0]?.timestamp?.slice(0, 16) || 'unknown'}`));
    lines.push('');

    return lines.join('\n');
  }

  /** Format a compact summary comparing top models */
  static formatSummary(results: BenchmarkResult[]): string {
    if (results.length === 0) return '  No results.';

    const lines: string[] = [''];
    lines.push(chalk.bold('  Benchmark Summary'));
    lines.push('');

    // Best overall
    const best = results[0];
    lines.push(`  🏆 Best overall: ${chalk.cyan(best.model)} (${best.overall}/100)`);

    // Best per category
    const categories = ['toolCalling', 'codeGeneration', 'codeEditing', 'instructionFollowing', 'reasoning'] as const;
    const labels = { toolCalling: 'Tool calling', codeGeneration: 'Code generation', codeEditing: 'Code editing', instructionFollowing: 'Instruction following', reasoning: 'Reasoning' };

    for (const cat of categories) {
      const bestInCat = [...results].sort((a, b) => b.scores[cat] - a.scores[cat])[0];
      if (bestInCat) {
        lines.push(`  ${labels[cat].padEnd(22)} ${chalk.cyan(bestInCat.model)} (${bestInCat.scores[cat]}/100)`);
      }
    }

    // Fastest
    const fastest = [...results].sort((a, b) => b.performance.tokensPerSecond - a.performance.tokensPerSecond)[0];
    if (fastest) {
      lines.push(`  ${'Fastest'.padEnd(22)} ${chalk.cyan(fastest.model)} (${fastest.performance.tokensPerSecond} tok/s)`);
    }

    // Best value (high score / low params)
    const value = [...results]
      .map(r => ({
        ...r,
        value: r.overall / Math.max(parseFloat(r.parameterSize) || 1, 1),
      }))
      .sort((a, b) => b.value - a.value)[0];
    if (value) {
      lines.push(`  ${'Best value'.padEnd(22)} ${chalk.cyan(value.model)} (${value.overall}/100 at ${value.parameterSize})`);
    }

    lines.push('');
    return lines.join('\n');
  }
}

function formatCtxSize(tokens: number): string {
  if (tokens >= 131072) return '128K';
  if (tokens >= 65536) return '64K';
  if (tokens >= 32768) return '32K';
  if (tokens >= 16384) return '16K';
  if (tokens >= 8192) return '8K';
  if (tokens >= 4096) return '4K';
  return '2K';
}

/** Generate realistic-looking code/text padding to fill context window */
function generateContextPadding(approxTokens: number): string {
  // ~4 chars per token on average
  const targetChars = approxTokens * 4;
  const lines: string[] = [
    'Here is a large codebase context for reference:',
    '',
    '```typescript',
  ];

  // Generate pseudo-code that looks like a real project
  const templates = [
    'export function process{N}(data: Record<string, unknown>): Result {',
    '  const validated = schema{N}.parse(data);',
    '  if (!validated.id) throw new Error("Missing ID in record {N}");',
    '  const result = await db.query("SELECT * FROM items WHERE batch = {N}");',
    '  logger.info(`Processing batch {N}: ${result.length} items`);',
    '  return { success: true, count: result.length, batch: {N} };',
    '}',
    '',
    'interface Config{N} {',
    '  endpoint: string;',
    '  timeout: number;',
    '  retries: number;',
    '  batchSize: number;',
    '}',
    '',
  ];

  let charCount = 0;
  let batch = 1;
  while (charCount < targetChars) {
    for (const tmpl of templates) {
      const line = tmpl.replace(/\{N\}/g, String(batch));
      lines.push(line);
      charCount += line.length + 1;
      if (charCount >= targetChars) break;
    }
    batch++;
  }

  lines.push('```');
  return lines.join('\n');
}

function colorScore(score: number): string {
  const str = String(score);
  if (score >= 80) return chalk.green(str);
  if (score >= 60) return chalk.yellow(str);
  if (score >= 40) return chalk.hex('#FFA500')(str);
  return chalk.red(str);
}
