import chalk from 'chalk';
import type { Config } from './config.js';

export interface ModelProfile {
  name: string;
  parameterSize: string;      // "8B", "35B", etc.
  parameterCount: number;     // numeric billions (8, 35, 70...)
  family: string;
  families: string[];
  quantization: string;
  contextLength: number;
  capabilities: string[];     // ["tools", "vision", "thinking", "code", "embedding"]
  isLoaded: boolean;          // currently in VRAM somewhere
  serverName: string | null;  // which server has it loaded
  diskSize: number;           // bytes
  tier: 'heavy' | 'standard' | 'light';
  score: number;              // computed ranking
}

interface OllamaTagsResponse {
  models: Array<{
    name: string;
    model: string;
    size: number;
    details: {
      family: string;
      families: string[];
      parameter_size: string;
      quantization_level: string;
    };
  }>;
}

interface DashboardServer {
  id: number;
  name: string;
  isOnline: boolean;
  loadedModels: Array<{
    name: string;
    context_length: number;
    size_vram: number;
    details: {
      family: string;
      families: string[];
      parameter_size: string;
      quantization_level: string;
    };
  }>;
  availableModels: Array<{
    name: string;
    size: number;
    details: {
      family: string;
      families: string[];
      parameter_size: string;
      quantization_level: string;
    };
  }>;
}

interface DashboardDiscovery {
  modelName: string;
  modelFamily: string | null;
  families: string[];
  parameterSize: string | null;
  quantization: string | null;
  description: string | null;
  capabilities: string[];
}

function parseParamSize(sizeStr: string): number {
  const match = sizeStr.match(/([\d.]+)\s*([BMK])/i);
  if (!match) return 0;
  const num = parseFloat(match[1]);
  const unit = match[2].toUpperCase();
  if (unit === 'B') return num;
  if (unit === 'M') return num / 1000;
  if (unit === 'K') return num / 1_000_000;
  return num;
}

function assignTier(paramCount: number): 'heavy' | 'standard' | 'light' {
  if (paramCount >= 25) return 'heavy';
  if (paramCount >= 6) return 'standard';
  return 'light';
}

function computeScore(profile: ModelProfile): number {
  let score = 0;

  // Parameter count is the primary quality signal
  score += Math.min(profile.parameterCount * 2, 100);

  // Tool calling support is critical for agent mode
  if (profile.capabilities.includes('tools')) score += 30;

  // Code specialization is valuable
  if (profile.capabilities.includes('code')) score += 10;

  // Thinking/reasoning is a plus
  if (profile.capabilities.includes('thinking')) score += 10;

  // Larger context window is better
  if (profile.contextLength >= 128000) score += 10;
  else if (profile.contextLength >= 32000) score += 5;

  // Currently loaded = no cold start penalty
  if (profile.isLoaded) score += 15;

  // Higher quantization = better quality
  const quant = profile.quantization.toUpperCase();
  if (quant.includes('F16') || quant.includes('FP16')) score += 8;
  else if (quant.includes('Q8')) score += 6;
  else if (quant.includes('Q6')) score += 4;
  else if (quant.includes('Q5') || quant.includes('Q4_K_M')) score += 2;

  // Penalize embedding-only models for agent use
  if (profile.capabilities.includes('embedding') && profile.capabilities.length === 1) {
    score -= 50;
  }

  return score;
}

export class ModelManager {
  private models: ModelProfile[] = [];
  private currentModel: string | null = null;
  private autoSwitch: boolean;
  private preferredModel: string | null;
  private turnsSinceSwitch = 0;

  constructor(private config: Config) {
    this.autoSwitch = config.autoSwitch;
    this.preferredModel = config.model;
  }

  /** Discover all models from proxy + dashboard */
  async discover(): Promise<void> {
    const [tags, servers, discoveries] = await Promise.all([
      this.fetchTags(),
      this.fetchServers(),
      this.fetchDiscoveries(),
    ]);

    // Build loaded model map from servers
    const loadedMap = new Map<string, { serverName: string; contextLength: number }>();
    for (const server of servers) {
      if (!server.isOnline) continue;
      for (const m of server.loadedModels) {
        loadedMap.set(m.name, {
          serverName: server.name,
          contextLength: m.context_length || 0,
        });
      }
    }

    // Build capabilities map from discoveries
    const capMap = new Map<string, string[]>();
    for (const d of discoveries) {
      capMap.set(d.modelName, d.capabilities || []);
    }

    // Build profiles from tags (deduplicated model list)
    const seen = new Set<string>();
    this.models = [];

    for (const model of tags) {
      if (seen.has(model.name)) continue;
      seen.add(model.name);

      const paramSize = model.details?.parameter_size || '0B';
      const paramCount = parseParamSize(paramSize);
      const loaded = loadedMap.get(model.name);
      const capabilities = capMap.get(model.name) || this.inferCapabilities(model.name, model.details?.family);

      const profile: ModelProfile = {
        name: model.name,
        parameterSize: paramSize,
        parameterCount: paramCount,
        family: model.details?.family || 'unknown',
        families: model.details?.families || [],
        quantization: model.details?.quantization_level || 'unknown',
        contextLength: loaded?.contextLength || 0,
        capabilities,
        isLoaded: !!loaded,
        serverName: loaded?.serverName || null,
        diskSize: model.size || 0,
        tier: assignTier(paramCount),
        score: 0,
      };
      profile.score = computeScore(profile);
      this.models.push(profile);
    }

    // Sort by score descending
    this.models.sort((a, b) => b.score - a.score);
  }

  /** Pick the best default model */
  selectDefault(): string {
    // User override takes priority
    if (this.preferredModel) {
      const found = this.models.find(m => m.name === this.preferredModel);
      if (found) {
        this.currentModel = found.name;
        return found.name;
      }
    }

    // Best model with tool calling support
    const withTools = this.models.filter(m => m.capabilities.includes('tools'));
    if (withTools.length > 0) {
      this.currentModel = withTools[0].name;
      return withTools[0].name;
    }

    // Fallback to highest scored model
    if (this.models.length > 0) {
      this.currentModel = this.models[0].name;
      return this.models[0].name;
    }

    throw new Error('No models available on the proxy');
  }

  /** Evaluate if we should switch models based on conversation signals */
  evaluate(signals: ConversationSignals): string | null {
    if (!this.autoSwitch || !this.currentModel) return null;
    this.turnsSinceSwitch++;

    // Don't switch too frequently — minimum 3 turns between switches
    if (this.turnsSinceSwitch < 3) return null;

    const current = this.getProfile(this.currentModel);
    if (!current) return null;

    const complexity = this.computeComplexity(signals);

    // Determine target tier
    let targetTier: 'heavy' | 'standard' | 'light';
    if (complexity >= 8) targetTier = 'heavy';
    else if (complexity >= 3) targetTier = 'standard';
    else targetTier = 'light';

    // Don't switch if already at the right tier
    if (current.tier === targetTier) return null;

    // Find best model in target tier with tool support
    const candidates = this.models
      .filter(m => m.tier === targetTier && m.capabilities.includes('tools'))
      .sort((a, b) => b.score - a.score);

    // Fallback: if no tool-capable model in target tier, try adjacent tier
    if (candidates.length === 0) {
      if (targetTier === 'heavy') return null; // stay on current
      if (targetTier === 'light') {
        // Try standard tier instead
        const stdCandidates = this.models
          .filter(m => m.tier === 'standard' && m.capabilities.includes('tools'));
        if (stdCandidates.length > 0) {
          this.switchTo(stdCandidates[0].name);
          return stdCandidates[0].name;
        }
      }
      return null;
    }

    const selected = candidates[0];
    if (selected.name === this.currentModel) return null;

    this.switchTo(selected.name);
    return selected.name;
  }

  switchTo(model: string): void {
    this.currentModel = model;
    this.turnsSinceSwitch = 0;
  }

  getCurrentModel(): string {
    return this.currentModel || this.selectDefault();
  }

  getProfile(name: string): ModelProfile | undefined {
    return this.models.find(m => m.name === name);
  }

  getAllModels(): ModelProfile[] {
    return [...this.models];
  }

  getModelsByTier(tier: 'heavy' | 'standard' | 'light'): ModelProfile[] {
    return this.models.filter(m => m.tier === tier);
  }

  setAutoSwitch(enabled: boolean): void {
    this.autoSwitch = enabled;
  }

  /** Format model list for display */
  formatModelList(): string {
    const lines: string[] = [''];
    const tiers = ['heavy', 'standard', 'light'] as const;
    const tierLabels = { heavy: 'Heavy (25B+)', standard: 'Standard (6-25B)', light: 'Light (<6B)' };
    const tierColors = { heavy: chalk.red, standard: chalk.yellow, light: chalk.green };

    for (const tier of tiers) {
      const models = this.getModelsByTier(tier);
      if (models.length === 0) continue;

      lines.push(tierColors[tier](`  ${tierLabels[tier]}`));
      for (const m of models) {
        const active = m.name === this.currentModel ? chalk.cyan(' ← active') : '';
        const loaded = m.isLoaded ? chalk.green(' ●') : chalk.dim(' ○');
        const caps = m.capabilities.length > 0 ? chalk.dim(` [${m.capabilities.join(', ')}]`) : '';
        const score = chalk.dim(` (score: ${m.score})`);
        lines.push(`  ${loaded} ${m.name} ${chalk.dim(m.parameterSize)}${caps}${score}${active}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  private computeComplexity(signals: ConversationSignals): number {
    let complexity = 0;

    // File operations suggest coding complexity
    complexity += signals.fileOpsCount * 2;

    // Errors suggest model is struggling
    complexity += signals.errorCount * 3;

    // Multiple tool calls per turn = complex task
    complexity += signals.toolCallsLastTurn;

    // Long user messages = complex request
    if (signals.avgUserMessageLength > 500) complexity += 2;
    if (signals.avgUserMessageLength > 1000) complexity += 2;

    // Multi-file changes
    if (signals.uniqueFilesTouched > 3) complexity += 3;

    return complexity;
  }

  /** Infer capabilities from model name/family when discovery data unavailable */
  private inferCapabilities(name: string, family?: string): string[] {
    const caps: string[] = [];
    const lower = name.toLowerCase();

    // Most modern models support tools
    if (lower.includes('qwen') || lower.includes('llama') ||
        lower.includes('mistral') || lower.includes('gemma') ||
        lower.includes('phi') || lower.includes('command-r')) {
      caps.push('tools');
    }

    // Vision models
    if (lower.includes('vision') || lower.includes('llava') ||
        lower.includes('minicpm-v') || lower.includes('moondream')) {
      caps.push('vision');
    }

    // Code models
    if (lower.includes('code') || lower.includes('coder') ||
        lower.includes('starcoder') || lower.includes('deepseek-coder') ||
        lower.includes('codestral')) {
      caps.push('code');
    }

    // Thinking/reasoning
    if (lower.includes('think') || lower.includes('reason') || lower.includes('qwq')) {
      caps.push('thinking');
    }

    // Embedding models
    if (lower.includes('embed') || lower.includes('nomic-embed') ||
        lower.includes('bge-') || lower.includes('e5-')) {
      caps.push('embedding');
    }

    return caps;
  }

  private async fetchTags(): Promise<OllamaTagsResponse['models']> {
    try {
      const res = await fetch(`${this.config.proxyUrl}/api/tags`);
      if (!res.ok) return [];
      const data = await res.json() as OllamaTagsResponse;
      return data.models || [];
    } catch {
      return [];
    }
  }

  private async fetchServers(): Promise<DashboardServer[]> {
    try {
      const res = await fetch(`${this.config.dashboardUrl}/api/servers`);
      if (!res.ok) return [];
      return await res.json() as DashboardServer[];
    } catch {
      return [];
    }
  }

  private async fetchDiscoveries(): Promise<DashboardDiscovery[]> {
    try {
      const res = await fetch(`${this.config.dashboardUrl}/api/discoveries?hours=8760&limit=500`);
      if (!res.ok) return [];
      return await res.json() as DashboardDiscovery[];
    } catch {
      return [];
    }
  }
}

export interface ConversationSignals {
  fileOpsCount: number;
  errorCount: number;
  toolCallsLastTurn: number;
  avgUserMessageLength: number;
  uniqueFilesTouched: number;
}
