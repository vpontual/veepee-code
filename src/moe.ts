import { Ollama } from 'ollama';
import type { Message } from 'ollama';
import type { Config } from './config.js';
import type { ToolRegistry } from './tools/registry.js';
import type { ModelRoster } from './benchmark.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export type MoeStrategy = 'auto' | 'synthesize' | 'debate' | 'vote' | 'fastest';

export interface MoeResponse {
  strategy: MoeStrategy;
  responses: Array<{
    model: string;
    content: string;
    elapsed: number;
    role: string;  // e.g., "heavy thinker", "code specialist", "fast responder"
  }>;
  synthesis?: string;    // final merged answer (for synthesize/debate)
  winner?: string;       // which model won (for fastest)
}

interface MoeModel {
  name: string;
  role: string;
}

// ─── Strategy Detection ──────────────────────────────────────────────────────

const DEBATE_PATTERNS = [
  /\b(architect|design|approach|strategy|should\s+(we|i))\b/i,
  /\b(review|critique|evaluate|assess|compare)\b/i,
  /\b(trade.?off|pros?\s+and\s+cons?|advantages?|disadvantages?)\b/i,
  /\b(best\s+way|best\s+practice|recommend)\b/i,
];

const FASTEST_PATTERNS = [
  /\b(what\s+(does|is)|explain|describe|tell\s+me)\b/i,
  /\b(how\s+does|where\s+is|show\s+me)\b/i,
  /^(ls|cat|grep|find|git)\b/i,
];

const SYNTHESIZE_PATTERNS = [
  /\b(fix|write|create|implement|add|build|make|refactor)\b/i,
  /\b(update|change|modify|edit|convert|migrate)\b/i,
];

function detectStrategy(message: string): MoeStrategy {
  if (DEBATE_PATTERNS.some(p => p.test(message))) return 'debate';
  if (FASTEST_PATTERNS.some(p => p.test(message))) return 'fastest';
  if (SYNTHESIZE_PATTERNS.some(p => p.test(message))) return 'synthesize';
  return 'synthesize'; // default
}

// ─── MoE Engine ──────────────────────────────────────────────────────────────

export class MoeEngine {
  private ollama: Ollama;
  private models: MoeModel[] = [];

  constructor(config: Config, roster: ModelRoster | null) {
    this.ollama = new Ollama({ host: config.proxyUrl });

    // Build the 3-model panel from roster or defaults
    // Each should ideally route to different hardware via the proxy
    if (roster) {
      const seen = new Set<string>();
      const add = (name: string | null, role: string) => {
        if (name && !seen.has(name)) {
          seen.add(name);
          this.models.push({ name, role });
        }
      };

      add(roster.plan, 'Thinker');           // heaviest/best reasoning
      add(roster.code, 'Code Specialist');   // best at code
      add(roster.search, 'Fast Responder');  // fastest

      // If roster has duplicates, fill from known good models
      if (this.models.length < 3) add(roster.chat, 'Conversationalist');
      if (this.models.length < 3) add(roster.act, 'Generalist');
    }

    // Fallback defaults if roster didn't provide 3 distinct models
    if (this.models.length < 2) {
      this.models = [
        { name: 'qwen3.5:35b', role: 'Thinker' },
        { name: 'qwen2.5-coder:32b-instruct', role: 'Code Specialist' },
        { name: 'qwen3:8b', role: 'Fast Responder' },
      ];
    }
  }

  getModels(): MoeModel[] {
    return [...this.models];
  }

  /** Run MoE with auto-detected or forced strategy */
  async run(
    userMessage: string,
    systemPrompt: string,
    history: Message[],
    strategy: MoeStrategy = 'auto',
    onProgress?: (model: string, role: string, status: 'started' | 'streaming' | 'done', content?: string) => void,
  ): Promise<MoeResponse> {
    const effectiveStrategy = strategy === 'auto' ? detectStrategy(userMessage) : strategy;

    onProgress?.('system', 'MoE', 'started', `Strategy: ${effectiveStrategy} | ${this.models.map(m => m.role).join(' + ')}`);

    // Phase 1: Get responses from all models in parallel
    const responses = await this.queryAllModels(userMessage, systemPrompt, history, onProgress);

    // Phase 2: Apply strategy
    switch (effectiveStrategy) {
      case 'fastest':
        return this.applyFastest(effectiveStrategy, responses);

      case 'vote':
        return { strategy: effectiveStrategy, responses };

      case 'debate':
        return this.applyDebate(effectiveStrategy, responses, userMessage, systemPrompt, onProgress);

      case 'synthesize':
      default:
        return this.applySynthesize(effectiveStrategy, responses, userMessage, systemPrompt, onProgress);
    }
  }

  /** Query all models in parallel */
  private async queryAllModels(
    userMessage: string,
    systemPrompt: string,
    history: Message[],
    onProgress?: (model: string, role: string, status: 'started' | 'streaming' | 'done', content?: string) => void,
  ): Promise<MoeResponse['responses']> {
    const messages: Message[] = [
      { role: 'system', content: systemPrompt },
      ...history,
      { role: 'user', content: userMessage },
    ];

    const promises = this.models.map(async (model) => {
      onProgress?.(model.name, model.role, 'started');
      const start = Date.now();
      let content = '';

      try {
        const stream = await this.ollama.chat({
          model: model.name,
          messages,
          stream: true,
          keep_alive: '30m',
          options: { num_predict: 1024 },
        });

        for await (const chunk of stream) {
          if (chunk.message.content) {
            content += chunk.message.content;
            onProgress?.(model.name, model.role, 'streaming', content);
          }
        }
      } catch (err) {
        content = `Error: ${(err as Error).message}`;
      }

      const elapsed = Date.now() - start;
      onProgress?.(model.name, model.role, 'done', content);

      return { model: model.name, content, elapsed, role: model.role };
    });

    return Promise.all(promises);
  }

  /** Fastest strategy: return first completed response */
  private applyFastest(strategy: MoeStrategy, responses: MoeResponse['responses']): MoeResponse {
    const sorted = [...responses].sort((a, b) => a.elapsed - b.elapsed);
    return {
      strategy,
      responses: sorted,
      winner: sorted[0]?.model,
      synthesis: sorted[0]?.content,
    };
  }

  /** Synthesize strategy: ask the best model to merge all responses */
  private async applySynthesize(
    strategy: MoeStrategy,
    responses: MoeResponse['responses'],
    userMessage: string,
    systemPrompt: string,
    onProgress?: (model: string, role: string, status: 'started' | 'streaming' | 'done', content?: string) => void,
  ): Promise<MoeResponse> {
    // Use the thinker (first model) to synthesize
    const synthesizer = this.models[0];

    const synthesisPrompt = `You received responses from ${responses.length} different AI models to the same question. Synthesize the best parts into a single, high-quality answer. Be concise.

User's original question: "${userMessage}"

${responses.map(r => `--- ${r.role} (${r.model}, ${(r.elapsed / 1000).toFixed(1)}s) ---\n${r.content}`).join('\n\n')}

--- Your synthesized answer (take the best from each, resolve conflicts, be concise): ---`;

    onProgress?.(synthesizer.name, 'Synthesizer', 'started', 'Merging responses...');

    let synthesis = '';
    try {
      const stream = await this.ollama.chat({
        model: synthesizer.name,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: synthesisPrompt },
        ],
        stream: true,
          keep_alive: '30m',
        options: { num_predict: 1024 },
      });

      for await (const chunk of stream) {
        if (chunk.message.content) {
          synthesis += chunk.message.content;
          onProgress?.(synthesizer.name, 'Synthesizer', 'streaming', synthesis);
        }
      }
    } catch (err) {
      synthesis = responses[0]?.content || `Error: ${(err as Error).message}`;
    }

    onProgress?.(synthesizer.name, 'Synthesizer', 'done', synthesis);

    return { strategy, responses, synthesis };
  }

  /** Debate strategy: models critique each other, then synthesize */
  private async applyDebate(
    strategy: MoeStrategy,
    responses: MoeResponse['responses'],
    userMessage: string,
    systemPrompt: string,
    onProgress?: (model: string, role: string, status: 'started' | 'streaming' | 'done', content?: string) => void,
  ): Promise<MoeResponse> {
    // Round 2: Each model critiques the others
    const critiquePrompt = (responder: string, others: MoeResponse['responses']) => {
      return `You are reviewing other AI responses to: "${userMessage}"

${others.map(r => `--- ${r.role} (${r.model}) ---\n${r.content}`).join('\n\n')}

Briefly note what each got right and wrong. Then give your improved final answer. Be concise.`;
    };

    onProgress?.('system', 'Debate', 'started', 'Round 2: Models critiquing each other...');

    // Pick the 2 best models for the critique round (skip the fastest/smallest)
    const debaters = this.models.slice(0, 2);
    const critiquePromises = debaters.map(async (model) => {
      const others = responses.filter(r => r.model !== model.name);
      onProgress?.(model.name, model.role, 'started', 'Critiquing...');

      let content = '';
      try {
        const stream = await this.ollama.chat({
          model: model.name,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: critiquePrompt(model.name, others) },
          ],
          stream: true,
          keep_alive: '30m',
          options: { num_predict: 1024 },
        });

        for await (const chunk of stream) {
          if (chunk.message.content) {
            content += chunk.message.content;
            onProgress?.(model.name, model.role, 'streaming', content);
          }
        }
      } catch (err) {
        content = `Error: ${(err as Error).message}`;
      }

      onProgress?.(model.name, model.role, 'done', content);
      return { model: model.name, content, elapsed: 0, role: `${model.role} (critique)` };
    });

    const critiques = await Promise.all(critiquePromises);

    // Final synthesis from the thinker
    const allResponses = [...responses, ...critiques];
    return this.applySynthesize(strategy, allResponses, userMessage, systemPrompt, onProgress);
  }
}
