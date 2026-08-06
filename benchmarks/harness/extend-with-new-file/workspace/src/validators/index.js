import { required } from './required.js';
import { email } from './email.js';

export { required } from './required.js';
export { email } from './email.js';

/** Resolved by name from a rule set. Every validator must appear here. */
export const REGISTRY = {
  required,
  email,
};
