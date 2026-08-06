export interface User {
  id: number;
  name: string;
  email?: string;
}

const USERS: User[] = [
  { id: 1, name: 'ada' },
  { id: 2, name: 'grace', email: 'grace@example.com' },
  { id: 3, name: 'alan', email: 'alan@example.org' },
];

/** Look up a user by id. Throws if there is no such user. */
export function findUser(id: number): User {
  return USERS.find((u) => u.id === id);
}

/** The domain part of a user's email address. Throws if they have none. */
export function domainOf(id: number): string {
  const user = findUser(id);
  return user.email.split('@')[1];
}
