export class InvalidInputError<E extends Error> extends Error {
  name = 'InvalidInputError' as const;
  cause?: E;
  constructor(message: string, cause?: E) {
    super(message);
    this.cause = cause;
  }
}

export class UnauthorizedError extends Error {
  name = 'UnauthorizedError' as const;
  constructor(message: string) {
    super(message);
  }
}

export class NotFoundError extends Error {
  name = 'NotFoundError' as const;
  constructor(message: string) {
    super(message);
  }
}

export class ConflictError extends Error {
  name = 'ConflictError' as const;
  constructor(message: string) {
    super(message);
  }
}
