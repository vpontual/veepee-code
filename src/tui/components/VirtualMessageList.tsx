import { useMemo, useRef } from 'react';
import type { Message } from '../types.js';
import { formatMessage } from './MessageBlock.js';

interface CachedMessage {
  /** The message identity (index + content hash) */
  key: string;
  /** Formatted output lines */
  lines: string[];
  /** Terminal width used for formatting */
  width: number;
}

/**
 * Virtual message formatting — only formats messages in/near the viewport.
 * Caches formatted output per message to avoid re-processing on every render.
 *
 * Returns the full array of rendered lines, but only calls formatMessage
 * on messages whose output might be visible.
 */
export function useVirtualMessages(
  messages: Message[],
  maxWidth: number,
  visibleRows: number,
  scrollOffset: number,
): { renderedLines: string[]; totalMessages: number } {
  const cache = useRef<Map<string, CachedMessage>>(new Map());

  return useMemo(() => {
    const currentCache = cache.current;

    // Estimate lines per message (rough: 3 lines average + 1 spacing)
    const avgLinesPerMessage = 4;
    const totalEstimatedLines = messages.length * avgLinesPerMessage;

    // Determine which messages are near the viewport
    const maxScroll = Math.max(0, totalEstimatedLines - visibleRows);
    const scrollPos = scrollOffset > 0 ? maxScroll - Math.min(scrollOffset, maxScroll) : maxScroll;

    // Convert line position to approximate message index
    const viewportStartMsg = Math.max(0, Math.floor(scrollPos / avgLinesPerMessage) - 5);
    const viewportEndMsg = Math.min(messages.length, Math.ceil((scrollPos + visibleRows) / avgLinesPerMessage) + 5);

    const renderedLines: string[] = [];

    for (let mi = 0; mi < messages.length; mi++) {
      const msg = messages[mi];
      const prevMsg = mi > 0 ? messages[mi - 1] : null;

      // Spacing between messages
      if (mi > 0) {
        if (msg.role === 'user') {
          renderedLines.push(' ', ' ');
        } else if (msg.role === 'assistant' && prevMsg?.role !== 'assistant') {
          renderedLines.push(' ');
        } else if (msg.role === 'system' && prevMsg?.role === 'assistant') {
          renderedLines.push(' ');
        } else if (msg.role === 'tool_call' || msg.role === 'tool_result') {
          renderedLines.push(' ');
        }
      }

      // Only format messages near the viewport; use cache for others
      const cacheKey = `${mi}:${msg.role}:${(msg.content || '').length}:${msg.content?.slice(0, 50) ?? ''}`;

      let lines: string[];
      const cached = currentCache.get(cacheKey);

      if (cached && cached.width === maxWidth) {
        lines = cached.lines;
      } else if (mi >= viewportStartMsg && mi <= viewportEndMsg) {
        // In viewport — format now
        lines = formatMessage(msg, maxWidth);
        currentCache.set(cacheKey, { key: cacheKey, lines, width: maxWidth });
      } else {
        // Out of viewport — use placeholder estimate
        const estimatedHeight = Math.max(1, Math.ceil((msg.content?.length ?? 20) / maxWidth));
        lines = new Array(estimatedHeight).fill(' ');
      }

      renderedLines.push(...lines);
    }

    // Evict old cache entries
    if (currentCache.size > messages.length * 2) {
      const keys = new Set(messages.map((msg, i) =>
        `${i}:${msg.role}:${(msg.content || '').length}:${msg.content?.slice(0, 50) ?? ''}`
      ));
      for (const k of currentCache.keys()) {
        if (!keys.has(k)) currentCache.delete(k);
      }
    }

    return { renderedLines, totalMessages: messages.length };
  }, [messages, messages.length, maxWidth, visibleRows, scrollOffset]);
}
