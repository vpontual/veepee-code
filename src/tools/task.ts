/**
 * `task` tool — spawns a subagent. The model calls this when it wants to
 * fan out work into a parallel subagent or run something with a fresh
 * conversation context.
 *
 * Critical for fleet-aware routing: the `model` parameter is passed through
 * to the Ollama client unchanged. The Ollama Proxy routes requests by model
 * name to whichever fleet server has it loaded. So a subagent on
 * "gemma4:26b-a4b" runs on AGX while the parent runs on DGX — true GPU
 * parallelism, not just vLLM batching.
 */

import { z } from 'zod';
import type { ToolDef, ToolResult } from './types.js';
import type { SubAgentManager } from '../subagent.js';

export function createTaskTool(subagentMgr: SubAgentManager): ToolDef {
  return {
    name: 'task',
    description: [
      'Spawn a subagent to handle a focused, self-contained task. Subagents have isolated context and (when targeting a different fleet model) run in parallel with the parent.',
      '',
      'Use when:',
      '  • The task is independent — fan out research/analysis without polluting your own context.',
      '  • You want a second opinion from a different model family (set `model` to e.g. "gemma4:26b-a4b").',
      '  • You\'d otherwise burn turns reading many files just to extract a few facts.',
      '',
      'Subagents return their final answer as the tool result. Default tool allowlist is read-only + web. Mutating tools must be opted in via the `tools` parameter.',
    ].join('\n'),
    schema: z.object({
      prompt: z.string().describe('The full task description. Be specific and self-contained — the subagent has no access to your conversation.'),
      model: z.string().optional().describe('Model name to run on. The proxy routes by name (e.g., "gemma4:26b-a4b" → AGX server, "qwen3:8b" → small Nano). Default: parent\'s primary model.'),
      tools: z.array(z.string()).optional().describe('Tool name allowlist. Default: read_file, glob, grep, list_files, web_search, web_fetch, http_request. Add edit_file/write_file/bash only when the subagent needs to mutate.'),
      description: z.string().optional().describe('Short one-line label for /agents listing (≤60 chars). Defaults to the first 60 chars of the prompt.'),
      run_in_background: z.boolean().optional().describe('When true, return immediately with the agent ID. Use /agents output <id> to retrieve the result later.'),
      max_turns: z.number().optional().describe('Hard turn limit before the subagent forcibly returns. Default: 8.'),
    }),
    source: 'local',
    execute: async (params: Record<string, unknown>): Promise<ToolResult> => {
      const { id, result } = await subagentMgr.runTask({
        prompt: String(params.prompt),
        model: typeof params.model === 'string' ? params.model : undefined,
        tools: Array.isArray(params.tools) ? params.tools.map(String) : undefined,
        description: typeof params.description === 'string' ? params.description : undefined,
        runInBackground: params.run_in_background === true,
        maxTurns: typeof params.max_turns === 'number' ? params.max_turns : undefined,
      });

      if (!result) {
        // Background — caller will collect via /agents output <id>.
        return {
          success: true,
          output: `Subagent ${id} started in background. Retrieve result with: /agents output ${id}`,
        };
      }

      const meta = `[subagent ${id} on ${result.model}, ${result.elapsed}ms, ${result.toolCalls.length} tool calls]`;
      if (!result.success) {
        return {
          success: false,
          output: '',
          error: `${meta}\n${result.error || 'subagent failed'}`,
        };
      }
      return {
        success: true,
        output: `${meta}\n\n${result.content}`,
      };
    },
  };
}
