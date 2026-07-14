/**
 * Teacher-escalation self-learning loop.
 *
 * When a WEAK local model (the "student") fails an agentic run, a STRONG
 * "teacher" model (our DGX Qwen3.6-35B) distills a reusable skill from the
 * failed attempt so the student succeeds unaided next time. The skill lands in
 * `~/.veepee-code/skills/` where vcode's lazy skill_invoke loader picks it up on
 * the very next run (see skills.ts) — no restart.
 *
 * Pattern adapted (not copied — Odysseus is AGPL) from Odysseus's
 * teacher-escalation. Two guards carried over verbatim because they're the
 * non-obvious correctness bits:
 *   1. never escalate a student that is already a top-tier/teacher model
 *      (no point, and it stops the teacher escalating itself);
 *   2. only persist a skill if the teacher's OWN output passes the same
 *      give-up check — a teacher that also flails must not teach.
 *
 * This module is pure/self-contained (raw fetch to the teacher endpoint, fs for
 * the skill file) so it can be unit-tested without standing up an Agent.
 */
import { writeFileSync, mkdirSync, existsSync, readdirSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { getConfigDir } from './config.js';

/** What one completed run looked like — assembled by the caller from the
 *  agent's event stream (see agent.ts AgentEvent / tool_result.success). */
export interface RunOutcome {
  userMessage: string;
  studentModel: string;
  /** Final assistant text of the run. */
  assistantText: string;
  toolCalls: Array<{ name: string; success: boolean; error?: string }>;
  /** Strings from `error` events during the run. */
  errors: string[];
  /** Stuck-loop detected (agent.ts signature detector). */
  stuck?: boolean;
}

export interface TeacherConfig {
  enabled: boolean;
  /** Full chat-completions URL, e.g. http://10.0.154.246:8000/v1/chat/completions */
  endpoint: string;
  /** Teacher model id, e.g. Qwen/Qwen3.6-35B-A3B-FP8 */
  model: string;
  apiKey?: string | null;
}

export interface EscalationResult {
  escalated: boolean;
  reason: string;
  skillName?: string;
  skillPath?: string;
}

// ── Tier-1 failure classifier (cheap; no LLM) ──────────────────────────────
// "give up" phrasing that means the model bailed rather than did the work.
const GIVE_UP =
  /\b(i (?:don'?t|do not) have (?:a |the |any )?tool|i (?:can'?t|cannot|am unable to|am not able to)\b|could you (?:please )?clarify|i lack the (?:ability|tools?|capability)|no tool (?:available|for that)|unable to (?:complete|proceed|help with)|i'?m sorry,? but i (?:can'?t|cannot))/i;

export function classifyFailure(o: RunOutcome): { failed: boolean; reason: string } {
  if (o.stuck) return { failed: true, reason: 'stuck loop (no progress)' };
  const toolErr = o.toolCalls.find((t) => !t.success);
  if (toolErr) return { failed: true, reason: `tool '${toolErr.name}' failed: ${(toolErr.error || '?').slice(0, 160)}` };
  if (o.errors.length) return { failed: true, reason: `run error: ${o.errors[0].slice(0, 160)}` };
  if (GIVE_UP.test(o.assistantText)) return { failed: true, reason: 'model gave up (no-tool / clarify)' };
  return { failed: false, reason: '' };
}

/** Guard 1: only escalate a genuinely weak self-hosted student. Never the
 *  teacher itself, never a top-tier model (nothing to learn). */
export function shouldEscalateStudent(studentModel: string, teacher: TeacherConfig): boolean {
  if (!studentModel) return false;
  const s = studentModel.toLowerCase();
  if (s === teacher.model.toLowerCase()) return false;
  // top-tier / cloud SOTA — escalation would be pointless
  if (/qwen3\.?6-35b|qwen3\.?6-a3b|gpt-[45]|o[0-9]|claude-|deepseek-v[34]|kimi|glm-4\.6|235b|480b/i.test(s)) return false;
  return true;
}

// ── teacher call (raw OpenAI-compatible chat) ──────────────────────────────
async function teacherChat(teacher: TeacherConfig, messages: Array<{ role: string; content: string }>, maxTokens = 1400): Promise<string> {
  const r = await fetch(teacher.endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(teacher.apiKey ? { authorization: `Bearer ${teacher.apiKey}` } : {}) },
    body: JSON.stringify({
      model: teacher.model,
      messages,
      temperature: 0.2,
      max_tokens: maxTokens,
      chat_template_kwargs: { enable_thinking: false },
    }),
    signal: AbortSignal.timeout(180000),
  });
  if (!r.ok) throw new Error(`teacher HTTP ${r.status}`);
  const j: any = await r.json();
  // DGX vLLM with --reasoning-parser routes output into `reasoning` when thinking
  // is off, leaving `content` empty; fall back so the teacher reply isn't blank.
  const m = j?.choices?.[0]?.message ?? {};
  return String(m.content || m.reasoning || '').trim();
}

const SKILL_SYSTEM = [
  'You are a senior engineer writing a reusable SKILL for a WEAKER coding agent that just failed a task.',
  'Distill the GENERAL, reusable procedure that would let the weak agent succeed at tasks like this next time —',
  'not a one-off answer to this exact input. Preserve every concrete detail that matters (tool names, flags, file',
  'paths, commands, gotchas).',
  '',
  'Output EXACTLY a Markdown skill file and nothing else:',
  '---',
  'name: <kebab-case-name>',
  'description: <one line, <=120 chars, when to reach for this>',
  'tags: <comma,separated>',
  '---',
  '## When to use',
  '<bullets>',
  '## Procedure',
  '<numbered, concrete steps — the exact tools/commands>',
  '## Pitfalls',
  '<what the weak model got wrong / must avoid>',
  '',
  'HARD RULE: if the failed task was a one-off, non-reusable, or you cannot produce a genuinely useful reusable',
  'procedure, reply with the single word NONE and nothing else. Do not invent a skill just to answer.',
].join('\n');

// ── skill validation + write ───────────────────────────────────────────────
function skillsDir(): string {
  return resolve(getConfigDir(), 'skills');
}

/** Validate the teacher's output is a real, useful skill file (frontmatter the
 *  loader accepts + a non-trivial body that isn't itself a give-up). */
export function validateSkill(md: string): { ok: boolean; reason: string; name?: string; description?: string } {
  const t = md.trim();
  if (!t || /^none\.?$/i.test(t)) return { ok: false, reason: 'teacher declined (NONE / not reusable)' };
  if (GIVE_UP.test(t)) return { ok: false, reason: 'teacher output also gave up' };
  if (!t.startsWith('---')) return { ok: false, reason: 'no frontmatter' };
  const end = t.indexOf('\n---', 3);
  if (end === -1) return { ok: false, reason: 'unterminated frontmatter' };
  const fm = t.slice(3, end);
  const name = /(^|\n)\s*name:\s*(.+)/.exec(fm)?.[2]?.trim().replace(/^['"]|['"]$/g, '');
  const description = /(^|\n)\s*description:\s*(.+)/.exec(fm)?.[2]?.trim().replace(/^['"]|['"]$/g, '');
  if (!name || !/^[a-z0-9][a-z0-9-]{1,60}$/i.test(name)) return { ok: false, reason: `bad/missing name: ${name ?? '(none)'}` };
  if (!description) return { ok: false, reason: 'missing description' };
  const body = t.slice(end + 4).trim();
  if (body.length < 60) return { ok: false, reason: 'body too thin' };
  return { ok: true, reason: 'ok', name, description };
}

function writeSkill(name: string, md: string, o: RunOutcome, existingNames: Set<string>): string {
  const dir = skillsDir();
  mkdirSync(dir, { recursive: true });
  // Stamp provenance into the frontmatter (loader ignores unknown keys; humans
  // and future audits see where it came from). Insert after the opening ---.
  const stamped = md.replace(
    /^---\n/,
    `---\nsource: teacher-escalation\nstudent_model: ${o.studentModel}\n`,
  );
  // Avoid clobbering a hand-written or better skill of the same name.
  let file = `${name}.md`;
  if (existingNames.has(name)) file = `${name}-taught.md`;
  const path = resolve(dir, file);
  writeFileSync(path, stamped.endsWith('\n') ? stamped : stamped + '\n', 'utf-8');
  return path;
}

function existingSkillNames(): Set<string> {
  const dir = skillsDir();
  const out = new Set<string>();
  if (!existsSync(dir)) return out;
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.md')) continue;
      const raw = readFileSync(resolve(dir, f), 'utf-8');
      const m = /(^|\n)\s*name:\s*(.+)/.exec(raw.slice(0, 400));
      if (m) out.add(m[2].trim().replace(/^['"]|['"]$/g, ''));
      else out.add(f.replace(/\.md$/, ''));
    }
  } catch { /* ignore */ }
  return out;
}

function summarizeAttempt(o: RunOutcome): string {
  const parts: string[] = [];
  if (o.toolCalls.length) {
    parts.push('Tools it tried: ' + o.toolCalls.map((t) => `${t.name}${t.success ? '' : `(FAILED: ${(t.error || '?').slice(0, 80)})`}`).join(', '));
  }
  if (o.errors.length) parts.push('Errors: ' + o.errors.slice(0, 3).map((e) => e.slice(0, 120)).join(' | '));
  if (o.assistantText) parts.push('It ended up saying: ' + o.assistantText.slice(0, 600));
  return parts.join('\n') || '(no visible output)';
}

/**
 * The loop: classify → guard → teacher distills a skill → validate → write.
 * Returns what happened (never throws for the caller's happy path — a failed
 * teacher call is just `escalated:false`).
 */
export async function escalateAndLearn(o: RunOutcome, teacher: TeacherConfig): Promise<EscalationResult> {
  if (!teacher.enabled) return { escalated: false, reason: 'teacher-escalation disabled' };
  if (!teacher.endpoint || !teacher.model) return { escalated: false, reason: 'no teacher endpoint/model configured' };

  const { failed, reason } = classifyFailure(o);
  if (!failed) return { escalated: false, reason: 'run succeeded — nothing to learn' };
  if (!shouldEscalateStudent(o.studentModel, teacher)) {
    return { escalated: false, reason: `student '${o.studentModel}' is not a weak self-hosted model` };
  }

  let md: string;
  try {
    md = await teacherChat(teacher, [
      { role: 'system', content: SKILL_SYSTEM },
      {
        role: 'user',
        content: `The weak model (${o.studentModel}) FAILED this task.\n\nTASK:\n${o.userMessage}\n\nWHAT IT DID:\n${summarizeAttempt(o)}\n\nFAILURE: ${reason}\n\nWrite the SKILL.md now (or NONE).`,
      },
    ]);
  } catch (e: any) {
    return { escalated: false, reason: `teacher call failed: ${e?.message || e}` };
  }

  const v = validateSkill(md);
  if (!v.ok) return { escalated: false, reason: `no skill written: ${v.reason}` };

  const path = writeSkill(v.name!, md, o, existingSkillNames());
  return { escalated: true, reason: `learned '${v.name}' from failure (${reason})`, skillName: v.name, skillPath: path };
}
