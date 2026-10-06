// Server-only adapter contract: pass an account resolved from a validated session
// or a database account after authentication, never a request/client payload.
export const MAX_USERNAME_LENGTH = 160;

export class AuthenticationError extends Error {
  constructor() {
    super('No valid authenticated user. Please log in.');
    this.name = 'AuthenticationError';
    this.code = 'AUTHENTICATION_REQUIRED';
    this.status = 401;
  }
}

export function authenticatedIdentity(account) {
  if (
    !account ||
    typeof account.name !== 'string' ||
    account.name.length > MAX_USERNAME_LENGTH ||
    !account.name.trim() ||
    !(
      (typeof account.id === 'string' && account.id.trim().length > 0) ||
      (Number.isSafeInteger(account.id) && account.id >= 0)
    )
  )
    throw new AuthenticationError();
  return { id: account.id, name: account.name.trim() };
}
