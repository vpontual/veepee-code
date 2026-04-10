---
title: "Models"
description: "Model discovery, ranking algorithm, tier system, model roster, and automatic model switching."
weight: 6
---

# Models

VEEPEE Code discovers all models available on your Ollama fleet, scores them, assigns tiers, and uses benchmark-driven roster assignments to select the best model for each role. In act mode, it can dynamically switch between models based on task complexity.

## Discovery

On startup, VEEPEE Code performs up to three parallel API calls:

1. **`GET /api/tags`** (proxy) -- Retrieves the list of all models available across your fleet, including parameter size, family, quantization level, and disk size.

2. **`GET /api/servers`** (dashboard) -- Queries the Ollama Fleet Manager dashboard for server status and currently loaded models, including context lengths and VRAM usage. Only called if `VEEPEE_CODE_DASHBOARD_URL` is configured.

3. **`GET /api/discoveries`** (dashboard) -- Fetches model capability annotations from the fleet manager's discovery database, including tool support, vision, thinking, code specialization, and embedding. Only called if `VEEPEE_CODE_DASHBOARD_URL` is configured.

These data sources are merged to build a complete `ModelProfile` for each model:

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

Models are sorted by score descending. Before the first benchmark runs, the highest-scoring model with tool-calling support (within the configured size limits) becomes the default.

## Size Limits

Two fields in `vcode.config.json` control which models are considered:

| Field | Default | Description |
|----------|---------|-------------|
| `maxModelSize` | `40` | Maximum parameter count in billions. Models larger than this are excluded from auto-selection. |
| `minModelSize` | `12` | Minimum parameter count in billions. Models smaller than this are skipped for act mode (prevents using tiny unreliable models for coding). |

These limits apply to both the initial model selection and benchmark candidacy. They do not prevent manual `/model <name>` switching.

## Model Roster

After the first-launch benchmark (or any `/benchmark` run), VEEPEE Code builds a **model roster** -- the best model for each role:

| Role | Selection Criteria | Used By |
|------|-------------------|---------|
| **act** | Best overall score with decent speed (>2 tok/s) | `/act` mode (default) |
| **plan** | Best reasoning score (>1 tok/s is fine -- can be slower) | `/plan` mode |
| **chat** | Fastest with good instruction following (>3 tok/s preferred, weighted toward speed) | `/chat` mode |
| **code** | Best code generation + editing combined (60% gen, 40% edit, >2 tok/s) | Future sub-agent use |
| **search** | Fastest with good tool calling (speed weighted 8x, >3 tok/s) | Future sub-agent use |

The same model can fill multiple roles. For example, if your best model is also the fastest, it might be assigned to act, plan, code, and search.

The roster is saved to `~/.veepee-code/benchmarks/roster.json` and loaded on every subsequent launch. Mode switching (`/plan`, `/chat`, `/act`) uses the roster to select models.

## Tier System

Models are assigned to tiers based on parameter count (used for display and auto-switching fallback):

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

When `autoSwitch: true` (the default in `vcode.config.json`), the agent monitors conversation signals and switches models when the task complexity changes. This only applies in act mode.

### Evaluation Timing

Auto-switch only evaluates **after the first tool turn** -- it will not trigger on the very first message. This prevents unwanted model changes before the agent has done any work and gives the complexity tracker meaningful signals to act on.

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
| 0-7 | Standard | Stay on standard (never auto-downgrades to light -- too unreliable for coding) |

### Switching Rules

- **Minimum cooldown:** 3 turns between switches (prevents oscillation)
- **Tool-calling required:** Only switches to models with tool-calling support
- **Size limits respected:** Models outside `minModelSize` / `maxModelSize` are excluded
- **Fallback:** If no model in the target tier has tool support within size limits, stays on current model
- **Plan/chat mode override:** Auto-switching is disabled in plan and chat modes (roster models are used instead)
- **Manual override:** `/model <name>` disables auto-switching until `/model auto` re-enables it
- **Vision auto-switch:** When image or screenshot paths are detected in a user message, the agent automatically switches to a vision-capable model for that turn, then restores the original model afterward

### /model Commands

```
/model                    # Show current model
/model qwen3.5:35b        # Switch to specific model (disables auto-switch)
/model qwen3              # Partial name match
/model auto               # Re-enable auto-switching
```

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

### Implementation Note

Benchmark-based model selection uses **ESM dynamic imports** (`import()`) rather than `require()`. The earlier `require()` approach broke in the ESM module system; this was fixed in v0.2.0.

## Effort Levels

Effort levels (`/effort low`, `/effort medium`, `/effort high`) adjust per-request generation parameters sent to Ollama:

| Level | `num_predict` | `temperature` | Effect |
|-------|---------------|---------------|--------|
| **low** | Reduced | Lower | Shorter, more deterministic responses |
| **medium** | Default | Default | Balanced (default) |
| **high** | Increased | Slightly higher | Longer, more exploratory responses |

These values are set **per request** in the Ollama API options, not globally. Changing effort level takes effect on the next message.

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
