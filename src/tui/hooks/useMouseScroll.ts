import { useEffect } from 'react';
import { useStdin } from 'ink';

/**
 * Hook to capture SGR mouse wheel events.
 * Ink's useInput doesn't handle mouse sequences, so we read raw stdin.
 */
export function useMouseScroll(onScroll: (direction: 'up' | 'down') => void, active = true): void {
  const { stdin } = useStdin();

  useEffect(() => {
    if (!active || !stdin) return;

    const handler = (data: Buffer) => {
      const str = data.toString();
      const match = str.match(/\x1b\[<(\d+);\d+;\d+[Mm]/);
      if (match) {
        const button = parseInt(match[1], 10);
        if (button === 64) onScroll('up');
        else if (button === 65) onScroll('down');
      }
    };

    stdin.on('data', handler);
    return () => { stdin.off('data', handler); };
  }, [stdin, onScroll, active]);
}
