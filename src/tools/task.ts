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
import { loadAgentDefinitions, type AgentDefinition } from '../agents.js';

export function createTaskTool(subagentMgr: SubAgentManager, agents: AgentDefinition[] = loadAgentDefinitions()): ToolDef {
  const byName = new Map(agents.map(a => [a.name, a]));
  const roster = agents.length === 0 ? [] : [
    '',
    'Named agents (pass `agent`; its instructions, tools and model become the defaults):',
    ...agents.map(a => `  • ${a.name}${a.model ? ` [${a.model}]` : ''} — ${a.description.split(/(?<=\.)\s/)[0].slice(0, 160)}`),
  ];
  return {
    name: 'task',
    // Spawns its own agent loop; can legitimately run for many minutes.
    timeoutMs: null,
    description: [
      'Spawn a subagent to handle a focused, self-contained task. Subagents have isolated context and (when targeting a different fleet model) run in parallel with the parent.',
      '',
      'Use when:',
      '  • The task is independent — fan out research/analysis without polluting your own context.',
      '  • You want a second opinion from a different model family (set `model` to e.g. "gemma4:26b-a4b").',
      '',
      'A subagent runs on OTHER hardware in the fleet — gemma4 on the Orin AGX, the small Qwen on a Nano —',
      'never a second copy of the main model on the same box. Fanning out uses machines that are otherwise idle;',
      'it does not divide the main box, which serves one model and cannot host two generations at once.',
      '  • You\'d otherwise burn turns reading many files just to extract a few facts.',
      '',
      'Subagents return their final answer as the tool result. Default tool allowlist is read-only + web. Mutating tools must be opted in via the `tools` parameter.',
      'With run_in_background: true you get an id back at once; collect the result with task_output(id), which waits for it. Start several, then collect each — they run in parallel.',
      ...roster,
    ].join('\n'),
    schema: z.object({
      prompt: z.string().describe('The full task description. Be specific and self-contained — the subagent has no access to your conversation.'),
      isolation: z.enum(['worktree']).optional().describe('"worktree": run in its own git worktree on its own branch (from the last commit). Use when parallel subagents edit files; you get back the branch to merge.'),
      agent: z.string().optional().describe('Name of a named agent to run as (see the list above). Explicit model/tools override its defaults.'),
      model: z.string().optional().describe('Model name to run on. The proxy routes by name (e.g., "gemma4:26b-a4b" → AGX server, "qwen3:8b" → small Nano). Default: parent\'s primary model.'),
      tools: z.array(z.string()).optional().describe('Tool name allowlist. Default: read_file, glob, grep, list_files, web_search, web_fetch, http_request. Add edit_file/write_file/bash only when the subagent needs to mutate.'),
      description: z.string().optional().describe('Short one-line label for /agents listing (≤60 chars). Defaults to the first 60 chars of the prompt.'),
      run_in_background: z.boolean().optional().describe('When true, return immediately with the agent ID. Use /agents output <id> to retrieve the result later.'),
      max_turns: z.number().optional().describe('Hard turn limit before the subagent forcibly returns. Default: 8.'),
    }),
    source: 'local',
    execute: async (params: Record<string, unknown>): Promise<ToolResult> => {
      const def = typeof params.agent === 'string' ? byName.get(params.agent) : undefined;
      if (typeof params.agent === 'string' && !def) {
        return { success: false, output: '', error: `No agent named "${params.agent}". Available: ${[...byName.keys()].join(', ') || '(none)'}` };
      }
      const { id, result } = await subagentMgr.runTask({
        prompt: String(params.prompt),
        model: typeof params.model === 'string' ? params.model : def?.model,
        tools: Array.isArray(params.tools) ? params.tools.map(String) : def?.tools,
        instructions: def?.instructions,
        isolation: params.isolation === 'worktree' ? 'worktree' : undefined,
        description: typeof params.description === 'string' ? params.description : (def ? `${def.name}: ${String(params.prompt).slice(0, 48)}` : undefined),
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

/**
 * `task_output` — collect a background subagent's result.
 *
 * run_in_background returned an id and nothing to wait on: a real DGX run
 * slept, then polled vcode's own HTTP API with curl to find out whether its
 * two worktree subagents had finished. This is the tool it was missing.
 */
export function createTaskOutputTool(subagentMgr: SubAgentManager): ToolDef {
  return {
    name: 'task_output',
    timeoutMs: null,
    description: 'Get the result of a background subagent started with task(run_in_background: true). Waits for it to finish by default (up to timeout_seconds). Omit id to list all subagents and their status.',
    schema: z.object({
      id: z.string().optional().describe('Subagent id returned by task, e.g. "sa-001"'),
      wait: z.boolean().optional().describe('Wait for it to finish (default true). false = return its current status at once.'),
      timeout_seconds: z.number().optional().describe('Longest to wait (default 600).'),
    }),
    source: 'local',
    execute: async (params: Record<string, unknown>): Promise<ToolResult> => {
      const id = typeof params.id === 'string' ? params.id : undefined;
      const agents = subagentMgr.listAgents();
      if (!id) {
        if (agents.length === 0) return { success: true, output: 'No subagents.' };
        return { success: true, output: agents.map(a => `${a.id}  ${a.status}  ${a.model}  ${a.description}`).join('\n') };
      }
      const tracked = agents.find(a => a.id === id);
      if (!tracked) return { success: false, output: '', error: `No subagent "${id}". Call task_output with no id to list them.` };
      if (tracked.status === 'running' && params.wait !== false) {
        const ms = (typeof params.timeout_seconds === 'number' ? params.timeout_seconds : 600) * 1000;
        const done = await Promise.race([
          subagentMgr.waitFor(id).then(() => true),
          new Promise<boolean>(r => setTimeout(() => r(false), ms)),
        ]);
        if (!done) return { success: true, output: `${id} is still running after ${Math.round(ms / 1000)}s.` };
      }
      const latest = subagentMgr.listAgents().find(a => a.id === id)!;
      if (latest.status === 'running') return { success: true, output: `${id} is still running.` };
      const r = latest.result;
      const meta = `[subagent ${id} ${latest.status} on ${latest.model}${r ? `, ${r.elapsed}ms, ${r.toolCalls.length} tool calls` : ''}]`;
      if (!r || !r.success) return { success: false, output: '', error: `${meta}\n${r?.error ?? 'no result'}` };
      return { success: true, output: `${meta}\n\n${r.content}` };
    },
  };
}
