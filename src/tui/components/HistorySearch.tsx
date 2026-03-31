import React from 'react';
import { Text, Box } from 'ink';
import { theme, icons } from '../theme.js';

interface HistorySearchProps {
  query: string;
  matches: string[];
  selectedIndex: number;
  maxWidth: number;
}

/** Reverse history search overlay (Ctrl+R) */
export function HistorySearch({ query, matches, selectedIndex, maxWidth }: HistorySearchProps): React.ReactElement {
  const visibleMatches = matches.slice(0, 8);

  return (
    <Box flexDirection="column">
      <Text>{theme.accent('reverse-i-search: ')}{theme.textBold(query)}{theme.dim('_')}</Text>
      {visibleMatches.length === 0 && query.length > 0 && (
        <Text>{theme.dim('  No matches')}</Text>
      )}
      {visibleMatches.map((match, i) => {
        const isSelected = i === selectedIndex;
        const truncated = match.length > maxWidth - 6 ? match.slice(0, maxWidth - 9) + '...' : match;
        return (
          <Text key={i}>
            {isSelected ? theme.accent(`${icons.arrow} `) : '  '}
            {isSelected ? theme.textBold(truncated) : theme.dim(truncated)}
          </Text>
        );
      })}
      {matches.length > 8 && (
        <Text>{theme.dim(`  ... ${matches.length - 8} more`)}</Text>
      )}
    </Box>
  );
}

/** Filter history entries by query */
export function searchHistory(history: string[], query: string): string[] {
  if (!query) return history.slice(-8).reverse();
  const lower = query.toLowerCase();
  return history.filter(h => h.toLowerCase().includes(lower)).reverse();
}
