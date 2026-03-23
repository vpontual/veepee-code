import { useState, useCallback } from 'react';

interface ScrollState {
  offset: number;
  scrollUp: (amount?: number) => void;
  scrollDown: (amount?: number) => void;
  resetScroll: () => void;
  getVisibleSlice: <T>(items: T[], visibleRows: number) => { items: T[]; startIndex: number };
}

export function useScrollable(): ScrollState {
  const [offset, setOffset] = useState(0);

  const scrollUp = useCallback((amount = 3) => {
    setOffset(prev => prev + amount);
  }, []);

  const scrollDown = useCallback((amount = 3) => {
    setOffset(prev => Math.max(0, prev - amount));
  }, []);

  const resetScroll = useCallback(() => {
    setOffset(0);
  }, []);

  const getVisibleSlice = useCallback(<T,>(items: T[], visibleRows: number): { items: T[]; startIndex: number } => {
    if (items.length <= visibleRows) {
      return { items, startIndex: 0 };
    }
    const maxScroll = items.length - visibleRows;
    const clampedOffset = Math.min(offset, maxScroll);
    const startIndex = maxScroll - clampedOffset;
    return {
      items: items.slice(startIndex, startIndex + visibleRows),
      startIndex,
    };
  }, [offset]);

  return { offset, scrollUp, scrollDown, resetScroll, getVisibleSlice };
}
