---
title: "Models"
description: "Model discovery, ranking algorithm, tier system, and automatic model switching."
weight: 6
---

# Models

VEEPEE Code discovers all models available on your Ollama fleet, scores them, assigns tiers, and dynamically switches between them based on task complexity.

## Discovery

On startup, VEEPEE Code performs three parallel API calls:

1. **`GET /api/tags`** (proxy) -- Retrieves the list of all models available across your fleet, including parameter size, family, quantization level, and disk size.

2. **`GET /api/servers`** (dashboard) -- Queries the Ollama Fleet Manager dashboard for server status and currently loaded models, including context lengths and VRAM usage.

3. **`GET /api/discoveries`** (dashboard) -- Fetches model capability annotations from the fleet manager's discovery database, including tool support, vision, thinking, code specialization, and embedding.

These three data sources are merged to build a complete `ModelProfile` for each model:

```typescript
interface ModelProfile {
  name: string;            // e.g., "qwen3.5:35b"
  parameterSize: string;   // "35B"
  parameterCount: number;  // 35
  family: string;          // "qwen3.5"
  families: string[];      // ["qwen3.5"]
  quantization: string;    // "Q4_K_M"
  contextLength: number;   // from loaded model data
  capabilities: string[];  // ["tools", "code", "thinking"]
  isLoaded: boolean;       // currently in VRAM
  serverName: string;      // which GPU server has it loaded
  diskSize: number;        // bytes on disk
  tier: "heavy" | "standard" | "light";
  score: number;           // computed ranking
}
```

## Ranking Algorithm

Every discovered model receives a composite score (0-200+ range). The scoring factors:

| Factor | Points | Description |
|--------|--------|-------------|
| Parameter count | Up to 100 | `min(params * 2, 100)` -- larger models score higher |
| Tool calling | +30 | Model supports function/tool calling |
| Code specialization | +10 | Model name suggests code focus |
| Thinking/reasoning | +10 | Model supports chain-of-thought |
| Context 128K+ | +10 | Large context window |
| Context 32K+ | +5 | Medium context window |
| Currently loaded | +15 | No cold-start penalty (already in VRAM) |
| FP16 quantization | +8 | Highest quality quantization |
| Q8 quantization | +6 | High quality |
| Q6 quantization | +4 | Good quality |
| Q5 / Q4_K_M | +2 | Acceptable quality |
| Embedding-only | -50 | Not useful for agent tasks |

Models are sorted by score descending. The highest-scoring model with tool-calling support becomes the default.

## Tier System

Models are assigned to tiers based on parameter count:

| Tier | Parameter Range | Typical Models | Use Case |
|------|----------------|----------------|----------|
| **Heavy** | 25B+ | qwen3.5:35b, llama4:scout, deepseek-r1:70b | Complex reasoning, architecture, multi-file refactoring |
| **Standard** | 6-25B | qwen3:8b, llama3.2:8b, gemma3:12b | General coding, most tasks |
| **Light** | <6B | phi4-mini:3.8b, qwen2.5:3b, gemma3:4b | Simple questions, quick lookups |

## /models Command

View all discovered models with their tiers, scores, capabilities, and loaded status:

```
/models
```

Output example:

```
  Heavy (25B+)
  ● qwen3.5:35b 35B [tools, code, thinking] (score: 142) ← active
  ○ deepseek-r1:70b 70B [tools, thinking] (score: 135)
  ○ llama4:scout 109B [tools, code] (score: 128)

  Standard (6-25B)
  ● qwen3:8b 8B [tools, code] (score: 82)
  ○ gemma3:12b 12B [tools] (score: 78)
  ○ llama3.2:8b 8B [tools] (score: 71)

  Light (<6B)
  ○ phi4-mini:3.8b 3.8B [tools, code] (score: 55)
  ○ qwen2.5:3b 3B [tools] (score: 48)
```

Legend:
- **●** Currently loaded in VRAM (fast, no cold start)
- **○** Available on disk (needs loading)
- **← active** The currently selected model

## Automatic Model Switching

When `VEEPEE_CODE_AUTO_SWITCH=true` (the default), the agent monitors conversation signals and switches models when the task complexity changes.

### Complexity Signals

The context manager tracks these signals every turn:

| Signal | Weight | Description |
|--------|--------|-------------|
| File operations | x2 per file | Number of unique files read/written/edited |
| Errors | x3 per error | Tool call errors or model errors |
| Tool calls per turn | x1 each | More parallel tool calls = more complex task |
| User message length | +2 at >500 chars, +4 at >1000 | Longer prompts suggest complex requests |
| Unique files touched | +3 at >3 files | Multi-file operations |

### Complexity Thresholds

| Complexity Score | Target Tier | Behavior |
|-----------------|-------------|----------|
| 8+ | Heavy | Switch to the best heavy-tier model |
| 3-7 | Standard | Switch to the best standard-tier model |
| 0-2 | Light | Switch to the best light-tier model |

### Switching Rules

- **Minimum cooldown:** 3 turns between switches (prevents oscillation)
- **Tool-calling required:** Only switches to models with tool-calling support
- **Fallback:** If no model in the target tier has tool support, tries the adjacent tier
- **Plan mode override:** Auto-switching is disabled in plan and chat modes
- **Manual override:** `/model <name>` disables auto-switching until `/model auto` re-enables it

### /model Commands

```
/model                    # Show current model
/model qwen3.5:35b        # Switch to specific model (disables auto-switch)
/model auto               # Re-enable auto-switching
```

Partial name matching is supported -- `/model qwen3.5` matches `qwen3.5:35b`.

## Capability Inference

When the dashboard discovery data is unavailable, VEEPEE Code infers capabilities from model names:

| Name Pattern | Inferred Capabilities |
|-------------|----------------------|
| qwen, llama, mistral, gemma, phi, command-r | `tools` |
| vision, llava, minicpm-v, moondream | `vision` |
| code, coder, starcoder, deepseek-coder, codestral | `code` |
| think, reason, qwq | `thinking` |
| embed, nomic-embed, bge-, e5- | `embedding` |

## Benchmark-Informed Context Sizes

If you have run `/benchmark`, the agent uses the optimal context size discovered during benchmarking for each model. This is passed as `num_ctx` to the Ollama API, ensuring each model operates at its empirically-tested sweet spot between quality and speed.

Without benchmark data, the default context size from the model's configuration is used.

## Knowledge Cutoffs

VEEPEE Code maintains a table of approximate training data cutoff dates for major model families. This is injected into the system prompt to help the model know when to search the web:

| Model Family | Cutoff |
|-------------|--------|
| qwen3.5 | 2025-04 |
| qwen3 | 2025-01 |
| qwen2.5 | 2024-09 |
| llama4 | 2025-02 |
| llama3.2 | 2024-06 |
| llama3.1 | 2024-04 |
| gemma3 | 2025-02 |
| mistral | 2024-07 |
| deepseek-r1 | 2025-01 |
| deepseek | 2024-11 |
| phi | 2024-10 |
| command-r | 2024-04 |
| nemotron | 2024-09 |
| glm | 2025-01 |

If a model family is not in the table, the cutoff defaults to 2024-06.
