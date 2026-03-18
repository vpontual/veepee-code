declare module 'marked-terminal' {
  export function markedTerminal(options?: Record<string, unknown>): unknown;
  const renderer: (...args: any[]) => any;
  export default renderer;
}
