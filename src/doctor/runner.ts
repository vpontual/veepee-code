import type { Check, CheckResult, DoctorSummary } from './types.js';

/** Run every check sequentially. Each check has a 10s hard timeout so a
 *  hung network call can't block the whole audit.
 *
 *  Sequential is intentional: parallel would race subprocesses and confuse
 *  shared resources (proxy connections, file watchers). The doctor is a
 *  diagnostic; it's allowed to take a few seconds. */
export async function runChecks(checks: Check[]): Promise<DoctorSummary> {
  const results: DoctorSummary['results'] = [];
  for (const check of checks) {
    const result = await runOne(check);
    results.push({ check, result });
  }
  const summary: DoctorSummary = {
    total: results.length,
    ok: results.filter((r) => r.result.severity === 'ok').length,
    warnings: results.filter((r) => r.result.severity === 'warn').length,
    errors: results.filter((r) => r.result.severity === 'error').length,
    info: results.filter((r) => r.result.severity === 'info').length,
    results,
  };
  return summary;
}

async function runOne(check: Check): Promise<CheckResult> {
  const TIMEOUT_MS = 10_000;
  try {
    return await Promise.race([
      check.run(),
      new Promise<CheckResult>((resolve) =>
        setTimeout(() => resolve({
          severity: 'error',
          message: 'Check timed out after 10s',
        }), TIMEOUT_MS),
      ),
    ]);
  } catch (err) {
    return {
      severity: 'error',
      message: 'Check threw an exception',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
