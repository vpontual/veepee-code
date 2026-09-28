/**
 * `request_approval` — the way out of verify.
 *
 * Verify is vcode's read-only-until-approved hold (`/verify`, off by default).
 * While it is on, edits, shell and subagents are refused with a reason (see
 * VERIFY_REFUSED_TOOLS in permissions.ts). The model reads and explores, then
 * calls `request_approval({ proposal })`. The proposal is shown through the
 * standard permission prompt; on approval verify turns off and the model
 * carries on in whatever mode and model the user was already in.
 *
 * This replaced plan mode (2026-09-28). Plan mode bundled three things — a
 * model switch, a prompt and this gate — and the user wanted them apart: the
 * second model is `/act 2`, and the hold is this.
 */

import { z } from 'zod';
import type { ToolDef, ToolResult } from './types.js';
import type { Agent } from '../agent.js';
import type { PermissionManager } from '../permissions.js';

export function createRequestApprovalTool(
  agent: Agent,
  permissions: PermissionManager,
): ToolDef {
  return {
    name: 'request_approval',
    description: [
      'Verify is on: edits, shell commands and subagents are held until the user approves.',
      'When you have explored enough, call this with exactly what you will change and why.',
      'On approval, verify turns off and every tool is available — carry out what you proposed.',
      'On rejection, verify stays on; revise the proposal and ask again.',
    ].join('\n'),
    schema: z.object({
      proposal: z.string().describe('What you will change, as markdown: numbered steps, the files involved, and anything the user should decide. This is what they see when approving.'),
    }),
    source: 'local',
    execute: async (params: Record<string, unknown>): Promise<ToolResult> => {
      // `plan` is what models trained on exit_plan_mode reach for.
      const proposal = String(params.proposal ?? params.plan ?? '').trim();
      if (!proposal) {
        return { success: false, output: '', error: 'request_approval needs a non-empty `proposal`.' };
      }
      if (!agent.getVerify()) {
        return { success: false, output: '', error: 'Verify is off: every tool is already available. Go ahead.' };
      }

      // The standard permission prompt, with the proposal as its preview.
      if (!(await permissions.approve('request_approval', proposal))) {
        return {
          success: false,
          output: '',
          error: 'The user did not approve. Verify stays on: ask what to change, revise, and request approval again.',
        };
      }

      agent.setVerify(false);
      return {
        success: true,
        output: 'Approved. Verify is off and every tool is available. Carry out the proposal now.',
      };
    },
  };
}
