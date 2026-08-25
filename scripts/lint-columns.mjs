#!/usr/bin/env npx tsx
/**
 * lint:columns — scan src/ for db.prepare() calls where the SQL selects
 * columns that don't cover property reads on the result.
 *
 * Prints file:line, the query snippet, and missing columns.
 * Exits 1 when any finding is reported, 0 otherwise.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { scanSource } from '../src/lint/scan.js';

const ROOT = join(import.meta.dirname, '..');
const SRC = join(ROOT, 'src');
const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx'];

function collectFiles(dir) {
    const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip node_modules, dist, etc.
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') {
        continue;
      }
      files.push(...collectFiles(full));
    } else if (EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
      files.push(full);
    }
  }
  return files;
}

const allFiles = collectFiles(SRC);
let totalFindings = 0;

for (const filePath of allFiles) {
  const code = readFileSync(filePath, 'utf-8');
  const findings = scanSource(code);
  for (const f of findings) {
    const relPath = filePath.replace(ROOT + '/', '');
    console.log(`${relPath}:${f.line}`);
    console.log(`  query: ${f.query.slice(0, 120)}${f.query.length > 120 ? '…' : ''}`);
    console.log(`  missing: ${f.missing.join(', ')}`);
    console.log();
    totalFindings++;
  }
}

if (totalFindings > 0) {
  console.log(`Found ${totalFindings} issue(s).`);
  process.exit(1);
} else {
  console.log('No missing-column issues found.');
  process.exit(0);
}