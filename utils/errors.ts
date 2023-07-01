export class InvalidInputError<D> extends Error {
  cause?: D;
  constructor(message: string, cause?: D) {
    super(message);
    this.cause = cause;
    this.name = 'InvalidInputError';
  }
}

export class UnauthorizedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

export class StorageError extends Error {
  cause: Error;
  constructor(message: string, cause: Error) {
    super(message);
    this.name = 'StorageError';
    this.cause = cause;
  }
}
