export interface Attempt {
  n: number;
  max: number;
}

export function fetchUser(a: Attempt): string {
  if (a.n > a.max) {
    throw new Error('too many attempts');
  }
  return `user:${a.n}`;
}

export function fetchOrder(a: Attempt): string {
  if (a.n > a.max) {
    throw new Error('too many attempts');
  }
  return `order:${a.n}`;
}

export function fetchInvoice(a: Attempt): string {
  if (a.n > a.max) {
    throw new Error('too many attempts');
  }
  return `invoice:${a.n}`;
}

export function fetchReceipt(a: Attempt): string {
  if (a.n > a.max) {
    throw new Error('too many attempts');
  }
  return `receipt:${a.n}`;
}
