export type Level = 'info' | 'warn' | 'error';

/** Every level the logger knows about, least severe first. Drives `--level` help text. */
export const LEVELS: readonly Level[] = ['info', 'warn', 'error'];

/** Numeric severity, used for threshold filtering. */
export const SEVERITY: Record<Level, number> = {
  info: 10,
  warn: 20,
  error: 30,
};

/** True when `level` is at or above the configured threshold. */
export function enabled(level: Level, threshold: Level): boolean {
  return SEVERITY[level] >= SEVERITY[threshold];
}
