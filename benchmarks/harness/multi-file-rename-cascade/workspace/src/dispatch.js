import { readFileSync } from 'node:fs';
import * as handlers from './index.js';

/** Event name -> the exported function that handles it. */
const MAP = JSON.parse(readFileSync(new URL('../handlers.json', import.meta.url), 'utf8'));

export function dispatch(event, ...args) {
  const name = MAP[event];
  const fn = handlers[name];
  if (!fn) throw new Error(`no handler for event: ${event}`);
  return fn(...args);
}
