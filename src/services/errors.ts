export class AuthError extends Error {}
export class NotFoundError extends Error {}
export class StaleVersionError extends Error {
  constructor(public expected: number, public actual: number) {
    super(`stale version: expected ${expected}, actual ${actual}`);
  }
}
export class ConflictError extends Error {}
