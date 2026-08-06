/**
 * Every validator lives in its own file and exports a factory returning
 * `{ name, check(value, field) }`. `check` returns an error string, or null
 * when the value is acceptable.
 */
export function required() {
  return {
    name: 'required',
    check(value, field) {
      if (value === undefined || value === null || value === '') {
        return `${field} is required`;
      }
      return null;
    },
  };
}
