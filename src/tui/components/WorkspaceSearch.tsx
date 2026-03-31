import React from 'react';
import { Text, Box } from 'ink';
import { theme, icons } from '../theme.js';

export interface SearchResult {
  file: string;
  line: number;
  text: string;
}

interface WorkspaceSearchProps {
  query: string;
  results: SearchResult[];
  selectedIndex: number;
  maxWidth: number;
  searching: boolean;
}

/** Workspace search overlay (Ctrl+Shift+F or /search) */
export function WorkspaceSearch({ query, results, selectedIndex, maxWidth, searching }: WorkspaceSearchProps): React.ReactElement {
  const visibleResults = results.slice(0, 12);

  return (
    <Box flexDirection="column">
      <Text>{theme.accent('search: ')}{theme.textBold(query)}{theme.dim('_')}{searching ? theme.dim(' (searching...)') : ''}</Text>
      {visibleResults.length === 0 && query.length > 0 && !searching && (
        <Text>{theme.dim('  No results')}</Text>
      )}
      {visibleResults.map((r, i) => {
        const isSelected = i === selectedIndex;
        const fileStr = r.file.length > 40 ? '...' + r.file.slice(-37) : r.file;
        const lineStr = theme.dim(`:${r.line}`);
        const textStr = r.text.trim().slice(0, maxWidth - fileStr.length - 12);
        return (
          <Text key={i}>
            {isSelected ? theme.accent(`${icons.arrow} `) : '  '}
            {isSelected ? theme.accentBold(fileStr) : theme.accent(fileStr)}
            {lineStr}
            {'  '}
            {isSelected ? theme.text(textStr) : theme.dim(textStr)}
          </Text>
        );
      })}
      {results.length > 12 && (
        <Text>{theme.dim(`  ... ${results.length - 12} more results`)}</Text>
      )}
      <Text>{theme.dim('  Enter: insert path  Esc: close')}</Text>
    </Box>
  );
}
