/**
 * Doctor — health checks with optional inline auto-fix.
 *
 * Inspired by LazyVim's :checkhealth + :LazyHealth. Every check answers two
 * questions:
 *   1. Is this part of the dev environment in good shape? (run)
 *   2. If not, can I fix it without further input? (fix)
 *
 * Checks are pure-ish: they may make one network call or one stat() to
 * answer the question, but they should not mutate state. fix() is allowed
 * to mutate (install a binary, write to settings.json, etc.) and runs only
 * after explicit user confirmation.
 */

export type Severity = 'ok' | 'warn' | 'error' | 'info';

export interface CheckResult {
  /** Whether the check passed. ok = healthy. warn = degraded but functional.
   *  error = broken; the feature won't work. info = informational, not a
   *  pass/fail. */
  severity: Severity;
  /** One-line human-readable message. */
  message: string;
  /** Optional extra detail rendered indented under the message. */
  detail?: string;
}

export interface FixOutcome {
  /** Whether the fix succeeded. */
  ok: boolean;
  /** What happened, rendered to the user. */
  message: string;
}

export interface Check {
  /** Stable identifier — used for `/doctor only=<id>` and per-check skips. */
  id: string;
  /** Group label, rendered as a section header. */
  category: string;
  /** Short human-readable description. */
  description: string;
  /** Run the check. Should never throw — return error severity instead. */
  run(): Promise<CheckResult>;
  /** Optional fix. When present and the check fails, /doctor offers to
   *  apply it after user confirmation. fix() should validate by re-running
   *  the check internally and reporting accurately whether it succeeded. */
  fix?(): Promise<FixOutcome>;
  /** Optional one-line label for the fix prompt (defaults to "Apply fix"). */
  fixLabel?: string;
}

/** Doctor run summary returned from runChecks(). */
export interface DoctorSummary {
  total: number;
  ok: number;
  warnings: number;
  errors: number;
  info: number;
  results: Array<{ check: Check; result: CheckResult }>;
}
