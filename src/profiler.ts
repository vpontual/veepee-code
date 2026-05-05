/**
 * Tiny startup profiler. Activated by `vcode --profile`. Records labelled
 * marks during init and prints a human-readable breakdown to stderr right
 * before the TUI takes over.
 *
 * Cost when --profile is OFF: one branch per `mark()` call. Negligible.
 */

interface Mark {
  label: string;
  at: number;
}

export class Profiler {
  private enabled: boolean;
  private start: number;
  private marks: Mark[] = [];

  constructor(enabled: boolean) {
    this.enabled = enabled;
    this.start = Date.now();
  }

  /** Record a labelled mark. No-op when not enabled. */
  mark(label: string): void {
    if (!this.enabled) return;
    this.marks.push({ label, at: Date.now() });
  }

  /** Render the breakdown. Returns '' when not enabled. */
  render(): string {
    if (!this.enabled || this.marks.length === 0) return '';
    const lines: string[] = ['', 'Startup profile:'];
    let prev = this.start;
    let totalDelta = 0;
    for (const m of this.marks) {
      const delta = m.at - prev;
      totalDelta += delta;
      const since = m.at - this.start;
      lines.push(`  ${String(delta).padStart(5)}ms  [${String(since).padStart(5)}ms total]  ${m.label}`);
      prev = m.at;
    }
    lines.push(`  ─────`);
    lines.push(`  ${String(totalDelta).padStart(5)}ms  total init`);
    return lines.join('\n');
  }

  /** Print to stderr if enabled. */
  flush(): void {
    if (!this.enabled) return;
    const out = this.render();
    if (out) process.stderr.write(out + '\n');
  }
}
