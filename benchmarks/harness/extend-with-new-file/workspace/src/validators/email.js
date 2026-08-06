const PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function email() {
  return {
    name: 'email',
    check(value, field) {
      // Optional validators say nothing about an absent value — that is
      // `required`'s job, and reporting it twice reads badly in a form.
      if (value === undefined || value === null || value === '') {
        return null;
      }
      return PATTERN.test(String(value)) ? null : `${field} must be a valid email address`;
    },
  };
}
