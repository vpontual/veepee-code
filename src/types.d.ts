declare module 'marked-terminal' {
  export function markedTerminal(options?: Record<string, unknown>): unknown;
  const renderer: (...args: any[]) => any;
  export default renderer;
}

declare module 'qrcode-terminal' {
  export function generate(text: string, options?: { small?: boolean }, callback?: (code: string) => void): void;
  export function setErrorLevel(level: 'L' | 'M' | 'Q' | 'H'): void;
}
