/**
 * `exit_plan_mode` tool — the plan-mode gate.
 *
 * Plan mode is a thinking-and-research-only mode: edit_file, write_file,
 * and bash are filtered out by the agent (see PLAN_DISABLED_TOOLS in
 * agent.ts). To leave plan mode and start executing, the model must call
 * `exit_plan_mode({ plan: "..." })`. The tool surfaces the plan to the
 * user via the standard permission prompt (with the plan rendered as
 * preview), awaits explicit approval, then switches the agent into act
 * mode and persists the plan to `.veepee/plan.md`.
 *
 * This makes plan mode a hard gate, not advisory. The model cannot
 * accidentally start mutating files in the middle of "thinking through"
 * a problem — it must propose, the user must confirm, then act mode
 * unlocks the write tools.
 */

import { z } from 'zod';
import { writeFile, mkdir } from 'fs/promises';
import { resolve } from 'path';
import type { ToolDef, ToolResult } from './types.js';
import type { Agent } from '../agent.js';
import type { PermissionManager } from '../permissions.js';

/** Tool names that plan mode disables. The model can read, search, and
 *  think — but cannot mutate without first calling exit_plan_mode. */
export const PLAN_DISABLED_TOOLS = new Set<string>([
  'edit_file',
  'write_file',
  'bash',
  'shell',  // remote bridge variant
  'docker',
]);

export function createExitPlanModeTool(
  agent: Agent,
  permissions: PermissionManager,
): ToolDef {
  return {
    name: 'exit_plan_mode',
    description: [
      'Submit your plan for user approval and exit plan mode.',
      'Call this only when your plan is complete and you are ready to start executing.',
      'The user will be shown the plan and must explicitly approve before mutating tools (edit_file, write_file, bash) become available.',
      'On approval: agent switches to act mode, plan is persisted to .veepee/plan.md, and you can begin implementing.',
      'On rejection: you stay in plan mode; revise the plan and try again.',
    ].join('\n'),
    schema: z.object({
      plan: z.string().describe('The full plan as markdown. Include numbered steps, rationale for non-obvious decisions, and any open questions. This is what the user sees when deciding whether to approve.'),
    }),
    source: 'local',
    execute: async (params: Record<string, unknown>): Promise<ToolResult> => {
      const plan = String(params.plan ?? '').trim();
      if (!plan) {
        return { success: false, output: '', error: 'exit_plan_mode requires a non-empty `plan` argument.' };
      }
      if (agent.getMode() !== 'plan') {
        return {
          success: false,
          output: '',
          error: `exit_plan_mode is only callable in plan mode (current mode: ${agent.getMode()}). The act-mode tools you want are already available.`,
        };
      }

      // Reuse the standard permission prompt to get user confirmation.
      // The plan goes in the `preview` slot, so it's rendered above the
      // y/n options exactly like a diff would be.
      const decision = await permissions.check(
        'exit_plan_mode',
        { plan: '<full plan in preview>' },
        plan,
      );

      if (decision === 'deny') {
        return {
          success: false,
          output: '',
          error: 'User rejected the plan. Stay in plan mode, revise, and try again.',
        };
      }

      // Persist plan + flip mode to act.
      try {
        const planDir = resolve(process.cwd(), '.veepee');
        await mkdir(planDir, { recursive: true });
        await writeFile(resolve(planDir, 'plan.md'), plan + '\n', 'utf-8');
      } catch (err) {
        // Don't block the mode switch on a write failure — surface and
        // continue. User can re-save manually if needed.
        const msg = err instanceof Error ? err.message : String(err);
        return {
          success: true,
          output: `Plan approved but failed to persist to .veepee/plan.md: ${msg}\nMode switched to act anyway.`,
        };
      }
      agent.exitPlanMode();

      return {
        success: true,
        output: 'Plan approved by user. Switched to act mode. Mutating tools (edit_file, write_file, bash) are now available. Plan saved to .veepee/plan.md — update it with [DONE] markers as you complete steps.',
      };
    },
  };
}
