import React, { useState, useEffect, useRef } from 'react';
import { Text } from 'ink';
import chalk from 'chalk';

interface ProgressBarProps {
  active: boolean;
  enabled: boolean;
  cols: number;
}

export function ProgressBar({ active, enabled, cols }: ProgressBarProps): React.ReactElement | null {
  const [pos, setPos] = useState(0);
  const dirRef = useRef(1);

  useEffect(() => {
    if (!active || !enabled) {
      setPos(0);
      dirRef.current = 1;
      return;
    }

    const interval = setInterval(() => {
      setPos(prev => {
        const next = prev + dirRef.current * 3;
        if (next >= cols - 12) {
          dirRef.current = -1;
          return cols - 12;
        }
        if (next <= 0) {
          dirRef.current = 1;
          return 0;
        }
        return next;
      });
    }, 30);

    return () => clearInterval(interval);
  }, [active, enabled, cols]);

  if (!active || !enabled) {
    return <Text>{' '.repeat(cols)}</Text>;
  }

  const segmentLen = 12;
  const clampedPos = Math.max(0, Math.min(pos, cols - segmentLen));

  let line = '';
  for (let i = 0; i < cols; i++) {
    if (i >= clampedPos && i < clampedPos + segmentLen) {
      const distFromCenter = Math.abs(i - clampedPos - segmentLen / 2) / (segmentLen / 2);
      if (distFromCenter < 0.3) {
        line += chalk.hex('#85C7F2')('━');
      } else if (distFromCenter < 0.7) {
        line += chalk.hex('#4A8AB5')('━');
      } else {
        line += chalk.hex('#2A5A7A')('━');
      }
    } else {
      line += chalk.hex('#1A1A2E')('─');
    }
  }

  return <Text>{line}</Text>;
}
