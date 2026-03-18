---
title: "Benchmarking"
description: "Built-in model benchmarking: test categories, scoring, context probing, and interpreting results."
weight: 7
---

# Benchmarking

VEEPEE Code includes a built-in benchmarking system that tests your models across five categories relevant to coding assistant tasks. Results are used by the model manager to set optimal context sizes and inform model selection.

## Running Benchmarks

### Benchmark all models

```
/benchmark
```

Runs the full test suite against every non-embedding model discovered on your fleet. This can take 10-30 minutes depending on the number of models and their speed.

### Benchmark a specific tier

```
/benchmark heavy       # Only heavy-tier models (25B+)
/benchmark standard    # Only standard-tier models (6-25B)
/benchmark light       # Only light-tier models (<6B)
```

### View results

```
/benchmark results     # Show the results table from the last run
/benchmark summary     # Show the compact summary with category winners
```

## Test Categories

The benchmark suite contains 10 test cases across five categories, each with weighted scoring:

### 1. Tool Calling (Weight: 30%)

Tests whether the model can correctly invoke tools with the right name and arguments.

| Test | Weight | What It Checks |
|------|--------|---------------|
| Simple tool call | 1.0 | Read a specific file -- correct tool name and path argument |
| Multi-arg tool call | 1.0 | Search with pattern, path, and include filter -- all args correct |
| Tool selection | 1.5 | Choose the best tool from three options (glob vs bash vs read_file) |

Scoring criteria:
- Calling the correct tool: 30 points
- Correct primary argument: 30 points
- Correct secondary arguments: 20 points each
- Choosing the optimal tool (glob > bash > read_file for listing): bonus points

### 2. Code Generation (Weight: 25%)

Tests the quality of generated code.

| Test | Weight | What It Checks |
|------|--------|---------------|
| Simple function | 1.0 | Write an `isPrime` function -- correct logic, edge case handling |
| TypeScript with types | 1.0 | Write an interface + factory function -- correct types, optional fields |
| Bug fix | 1.5 | Identify `push` vs `concat` bug in a flatten function -- explanation + fix |

Scoring criteria:
- Correct function structure: 20 points
- Correct naming: 20 points
- Correct logic: 20 points
- Edge case handling: 20 points
- Complete solution: 20 points

### 3. Code Editing (Weight: 15%)

Tests precise string replacement ability.

| Test | Weight | What It Checks |
|------|--------|---------------|
| Exact string replacement | 1.5 | Given code, produce exact OLD and NEW strings for a find-replace |

Scoring criteria:
- Correct old string identification: 50 points
- Correct new string: 50 points

### 4. Instruction Following (Weight: 15%)

Tests whether the model follows format constraints and stays concise.

| Test | Weight | What It Checks |
|------|--------|---------------|
| Format constraint | 1.0 | List exactly 3 items, numbered, no extra text |
| Conciseness | 1.0 | Answer "2 + 2" with just "4" |

Scoring criteria:
- Exact format match: 40 points
- Numbered items: 30 points
- No unnecessary verbosity: 30 points

### 5. Reasoning (Weight: 15%)

Tests multi-step logic and edge case awareness.

| Test | Weight | What It Checks |
|------|--------|---------------|
| Multi-step logic | 1.0 | Find second-largest unique number -- dedup, sort, select |
| Edge case awareness | 1.0 | List edge cases for a division function |

Scoring criteria:
- Correct intermediate steps: 20-40 points
- Correct final answer: 40 points
- Identifying relevant edge cases: 15-35 points per case

## Overall Score Calculation

The overall score (0-100) is a weighted average:

```
Overall = Tools * 0.30 + CodeGen * 0.25 + Edit * 0.15 + Follow * 0.15 + Reason * 0.15
```

Tool calling and code generation are weighted highest because they are the most critical capabilities for a coding CLI.

## Context Size Probing

After running the test suite, each model undergoes context size probing. This tests the model at seven context window sizes:

- 2K, 4K, 8K, 16K, 32K, 64K, 128K tokens

For each size:

1. Context padding fills ~60% of the window with realistic-looking TypeScript code
2. A reference question is asked ("What is the sum of the first 10 prime numbers?")
3. The response is checked for correctness (expected: "129")
4. Speed (tokens/second) is measured

The **optimal context size** balances correctness and speed:

```
efficiency = quality_bonus * tokens_per_second
```

Where `quality_bonus` is 2.0 for correct answers and 0.5 for incorrect/empty answers. The size with the highest efficiency score becomes the model's optimal context, used automatically during agent operation.

The **maximum usable context** is the largest size that still produces output (before the model errors or hangs).

## Results Table

The `/benchmark results` command produces a table like this:

```
Rank  Model                          Size     Overall  Tools  CodeGen  Edit   Follow  Reason  tok/s    TTFT      Ctx
─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
   1  qwen3.5:35b                    35B         87     95      85     80      90      80     12    1200ms    32K
   2  qwen3:8b                       8B          72     80      75     70      65      70     28     450ms    16K
   3  llama3.2:8b                    8B          65     70      60     65      70      55     25     500ms     8K
   4  phi4-mini:3.8b                 3.8B        48     40      55     50      60      35     45     200ms     4K
```

Column descriptions:

| Column | Description |
|--------|-------------|
| Rank | Sorted by overall score |
| Model | Model name |
| Size | Parameter count |
| Overall | Weighted composite score (0-100) |
| Tools | Tool calling score |
| CodeGen | Code generation score |
| Edit | Code editing precision score |
| Follow | Instruction following score |
| Reason | Reasoning score |
| tok/s | Tokens per second (generation speed) |
| TTFT | Time to first token (cold start indicator) |
| Ctx | Optimal context window size |

Color coding: scores 80+ are green, 60-79 yellow, 40-59 orange, below 40 red.

## Benchmark Summary

The `/benchmark summary` command shows the winners:

```
  Benchmark Summary

  Best overall:           qwen3.5:35b (87/100)
  Tool calling            qwen3.5:35b (95/100)
  Code generation         qwen3.5:35b (85/100)
  Code editing            qwen3.5:35b (80/100)
  Instruction following   qwen3.5:35b (90/100)
  Reasoning               qwen3.5:35b (80/100)
  Fastest                 phi4-mini:3.8b (45 tok/s)
  Best value              qwen3:8b (72/100 at 8B)
```

**Best value** is calculated as `overall_score / parameter_count` -- the highest quality per unit of compute.

## Storage

Benchmark results are saved to:

```
~/.veepee-code/benchmarks/
├── latest.json                           # Always points to the most recent run
└── benchmark-2026-03-18T14-30-00-000Z.json  # Timestamped history
```

Each file contains an array of `BenchmarkResult` objects with full scores, performance metrics, context probing data, errors, and timestamps.

## Tips

- Run benchmarks after adding new models to your fleet to update rankings
- The agent automatically uses optimal context sizes from benchmark results
- Benchmark results persist across sessions -- run once, benefit always
- Use `/benchmark heavy` to quickly test just your flagship models
- Models with high TTFT (time to first token) have cold-start penalties; keep them loaded for best experience
