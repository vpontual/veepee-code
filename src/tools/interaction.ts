import { z } from 'zod';
import type { ToolDef } from './types.js';
import { ok } from './types.js';

/**
 * ask_user — a STRUCTURED clarification tool.
 *
 * Instead of the model asking a vague free-text question ("could you clarify?"),
 * it calls ask_user with typed options. The tool result carries a machine-
 * parseable `__ASK_USER__ {json}` marker so a headless/mesh orchestrator can
 * render choices (buttons) or auto-answer on the user's behalf, and a human-
 * readable rendering for the TUI. Turns a human-in-the-loop stall into a
 * machine-negotiable decision point across the mesh. (Pattern from Odysseus.)
 */
export function buildAskUserTool(): ToolDef {
  return {
    name: 'ask_user',
    description:
      'Ask the user a clarifying question with STRUCTURED options when you genuinely need a decision to proceed (and cannot infer a sensible default). Provide 2-6 concrete options. After calling this, STOP and present the question — do not guess. A person or an orchestrating agent answers precisely.',
    schema: z.object({
      question: z.string().describe('The clarifying question (one sentence).'),
      options: z
        .array(
          z.object({
            id: z.string().describe('short stable id, e.g. "postgres"'),
            label: z.string().describe('short choice label the user sees'),
            description: z.string().optional().describe('what choosing this means / the trade-off'),
          }),
        )
        .min(2)
        .max(6)
        .optional()
        .describe('Structured choices. Omit only if a free-text answer is truly required.'),
    }),
    source: 'local',
    execute: async (params) => {
      const question = String(params.question ?? '').trim();
      const options = (Array.isArray(params.options) ? params.options : []) as Array<{ id: string; label: string; description?: string }>;
      const payload = { ask_user: true, question, options };
      const human = options.length
        ? `${question}\n` + options.map((o, i) => `  ${i + 1}. ${o.label}${o.description ? ` — ${o.description}` : ''}`).join('\n')
        : question;
      return ok(`__ASK_USER__ ${JSON.stringify(payload)}\n\n${human}\n\n(Awaiting the user's choice — stop here and present these options; do not proceed on a guess.)`);
    },
  };
}
