/**
 * Ralph Loop — iterative Work → Review → Decision (SHIP/REVISE/ABANDON)
 *
 * Inspired by Goose's "Ralph" pattern: a worker model produces output, a reviewer
 * model critiques it, and the loop continues until the reviewer is satisfied or
 * max iterations are reached. Fresh context per iteration avoids noise accumulation.
 *
 * State persists in {cwd}/.veepee/ralph/ so work survives context compaction.
 */

import { writeFile, mkdir, readdir, readFile } from 'fs/promises';
import { resolve, join } from 'path';
import type { Config } from './config.js';
import type { ModelRoster } from './benchmark.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type RalphDecision = 'SHIP' | 'REVISE' | 'ABANDON';

export interface RalphIteration {
  n: number;
  workerOutput: string;
  reviewFeedback: string;
  decision: RalphDecision;
  timestamp: string;
}

export interface RalphState {
  id: string;
  task: string;
  iteration: number;
  maxIterations: number;
  workerModel: string;
  reviewerModel: string;
  iterations: RalphIteration[];
  status: 'running' | 'shipped' | 'abandoned' | 'max_iterations_reached';
  createdAt: string;
  updatedAt: string;
}

export type RalphEvent =
  | { type: 'worker_start'; iteration: number; model: string }
  | { type: 'worker_chunk'; content: string }
  | { type: 'worker_done'; content: string }
  | { type: 'reviewer_start'; iteration: number; model: string }
  | { type: 'reviewer_chunk'; content: string }
  | { type: 'reviewer_done'; content: string }
  | { type: 'decision'; decision: RalphDecision }
  | { type: 'done'; state: RalphState };

// ─── Engine ───────────────────────────────────────────────────────────────────

export class RalphEngine {
  constructor(
    private config: Config,
    private roster: ModelRoster | null,
    private currentModel: string,
  ) {}

  async *run(task: string, maxIterations = 5): AsyncGenerator<RalphEvent> {
    const workerModel = this.roster?.act ?? this.currentModel;
    const reviewerModel = this.roster?.plan ?? workerModel;

    function generateId(): string {
      return Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    }

    const state: RalphState = {
      id: generateId(),
      task,
      iteration: 0,
      maxIterations,
      workerModel,
      reviewerModel,
      iterations: [],
      status: 'running',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await this.saveState(state);

    for (let i = 0; i < maxIterations; i++) {
      state.iteration = i + 1;
      state.updatedAt = new Date().toISOString();

      // ── Worker turn ──────────────────────────────────────────────────────────
      yield { type: 'worker_start', iteration: i + 1, model: workerModel };
      const workerPrompt = this.buildWorkerPrompt(task, state);
      let workerOutput = '';
      for await (const chunk of this.streamModel(workerModel, workerPrompt)) {
        workerOutput += chunk;
        yield { type: 'worker_chunk', content: chunk };
      }
      yield { type: 'worker_done', content: workerOutput };

      // ── Reviewer turn ────────────────────────────────────────────────────────
      yield { type: 'reviewer_start', iteration: i + 1, model: reviewerModel };
      const reviewPrompt = this.buildReviewerPrompt(task, workerOutput, state);
      let reviewFeedback = '';
      for await (const chunk of this.streamModel(reviewerModel, reviewPrompt)) {
        reviewFeedback += chunk;
        yield { type: 'reviewer_chunk', content: chunk };
      }
      yield { type: 'reviewer_done', content: reviewFeedback };

      // ── Decision ─────────────────────────────────────────────────────────────
      const decision = this.parseDecision(reviewFeedback);
      yield { type: 'decision', decision };

      state.iterations.push({
        n: i + 1,
        workerOutput,
        reviewFeedback,
        decision,
        timestamp: new Date().toISOString(),
      });

      if (decision === 'SHIP') {
        state.status = 'shipped';
        state.updatedAt = new Date().toISOString();
        await this.saveState(state);
        yield { type: 'done', state };
        return;
      }

      if (decision === 'ABANDON') {
        state.status = 'abandoned';
        state.updatedAt = new Date().toISOString();
        await this.saveState(state);
        yield { type: 'done', state };
        return;
      }

      await this.saveState(state);
    }

    state.status = 'max_iterations_reached';
    state.updatedAt = new Date().toISOString();
    await this.saveState(state);
    yield { type: 'done', state };
  }

  private buildWorkerPrompt(task: string, state: RalphState): string {
    const lastFeedback = state.iterations[state.iterations.length - 1]?.reviewFeedback;
    if (lastFeedback) {
      return [
        `Task: ${task}`,
        '',
        `Iteration ${state.iteration}/${state.maxIterations}.`,
        '',
        'Previous reviewer feedback (address ALL of these points):',
        lastFeedback,
        '',
        'Produce a complete, improved result that addresses the feedback.',
      ].join('\n');
    }
    return [
      `Task: ${task}`,
      '',
      'Produce a complete, high-quality result. Be thorough.',
    ].join('\n');
  }

  private buildReviewerPrompt(task: string, workerOutput: string, state: RalphState): string {
    return [
      `You are a critical reviewer. The task was:`,
      task,
      '',
      `The worker produced (iteration ${state.iteration}/${state.maxIterations}):`,
      workerOutput,
      '',
      'Review the work critically. Identify any issues, missing pieces, or quality problems.',
      '',
      'End your review with EXACTLY ONE of these words on its own line:',
      '- SHIP    — work is complete and ready, no significant issues',
      '- REVISE  — work needs improvements (explain what specifically)',
      '- ABANDON — task is fundamentally flawed or not achievable',
    ].join('\n');
  }

  private parseDecision(text: string): RalphDecision {
    // Look for the decision keyword, preferably on its own line at the end
    const lines = text.split('\n').map(l => l.trim().toUpperCase());
    // Search from the end for a standalone decision keyword
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 5); i--) {
      const line = lines[i];
      if (line === 'SHIP' || line.startsWith('SHIP ') || line.endsWith(' SHIP')) return 'SHIP';
      if (line === 'ABANDON' || line.startsWith('ABANDON ') || line.endsWith(' ABANDON')) return 'ABANDON';
      if (line === 'REVISE' || line.startsWith('REVISE ') || line.endsWith(' REVISE')) return 'REVISE';
    }
    // Fall back to any occurrence in the text
    const upper = text.toUpperCase();
    if (/\bSHIP\b/.test(upper)) return 'SHIP';
    if (/\bABANDON\b/.test(upper)) return 'ABANDON';
    return 'REVISE'; // default: keep iterating
  }

  private async *streamModel(model: string, prompt: string): AsyncGenerator<string> {
    const { Ollama } = await import('ollama');
    const ollama = new Ollama({ host: this.config.proxyUrl });
    const stream = await ollama.chat({
      model,
      messages: [{ role: 'user', content: prompt }],
      stream: true,
      keep_alive: '30m',
      options: { num_predict: 4096, temperature: 0.6 },
    } as never);
    for await (const chunk of stream as AsyncIterable<{ message: { content: string } }>) {
      if (chunk.message.content) yield chunk.message.content;
    }
  }

  private async saveState(state: RalphState): Promise<void> {
    const dir = resolve(process.cwd(), '.veepee', 'ralph');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${state.id}.json`), JSON.stringify(state, null, 2));
  }

  /** List all saved ralph states in cwd */
  static async listStates(cwd = process.cwd()): Promise<RalphState[]> {
    const dir = resolve(cwd, '.veepee', 'ralph');
    try {
      const files = await readdir(dir);
      const states: RalphState[] = [];
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        try {
          const data = await readFile(join(dir, f), 'utf-8');
          states.push(JSON.parse(data) as RalphState);
        } catch { /* skip corrupt */ }
      }
      return states.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    } catch {
      return [];
    }
  }
}
