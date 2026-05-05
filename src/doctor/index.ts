export type { Check, CheckResult, FixOutcome, Severity, DoctorSummary } from './types.js';
export { runChecks } from './runner.js';
export { defaultChecks, lspBinariesMissing } from './checks.js';
export { renderDoctor } from './render.js';
