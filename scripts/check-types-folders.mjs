#!/usr/bin/env node

import { existsSync, readdirSync } from 'fs';
import { resolve } from 'path';

const typesDir = resolve(process.cwd(), 'node_modules', '@types');

if (!existsSync(typesDir)) {
  process.exit(0);
}

const entries = readdirSync(typesDir, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name);

// Malformed names we have seen in the wild:
// - "node 2", "chai 2", etc. (name + space + integer suffix)
// - trailing whitespace
const malformed = entries.filter((name) =>
  /\s+\d+$/.test(name) || /\s$/.test(name),
);

if (malformed.length === 0) {
  process.exit(0);
}

const quoted = malformed.map((name) => `"node_modules/@types/${name}"`).join(' ');
const msg = [
  '',
  '[veepee-code] Malformed @types directories detected.',
  `These break TypeScript type resolution: ${malformed.join(', ')}`,
  '',
  'Fix by removing them, then reinstalling dependencies if needed:',
  `  rm -rf ${quoted}`,
  '  npm install',
  '',
].join('\n');

console.error(msg);
process.exit(1);

