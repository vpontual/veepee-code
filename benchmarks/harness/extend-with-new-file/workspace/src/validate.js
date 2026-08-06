import { REGISTRY } from './validators/index.js';

/**
 * Run a rule set over an object and collect the errors.
 *
 *   validate({ email: 'x' }, { email: [['required'], ['email']] })
 *
 * Each spec is `[name, ...args]`; args are passed to the validator factory.
 */
export function validate(obj, rules) {
  const errors = [];
  for (const [field, specs] of Object.entries(rules)) {
    for (const [name, ...args] of specs) {
      const factory = REGISTRY[name];
      if (!factory) throw new Error(`unknown validator: ${name}`);
      const error = factory(...args).check(obj[field], field);
      if (error) errors.push(error);
    }
  }
  return errors;
}
