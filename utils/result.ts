type ErrResult<E extends Error> = {
  /** indicates the success or failure */
  ok: false;
  /** value that resulted from a successful execution */
  val: undefined;
  /** error that resulted from a failed execution */
  err: E;
};

type OkResult<D> = {
  /** indicates the success or failure */
  ok: true;
  /** value that resulted from a successful execution */
  val: D;
  /** error that resulted from a failed execution */
  err: undefined;
};

/** A type that represents the result of a function that may succeed or fail. */
export type Result<D, E extends Error = Error> = OkResult<D> | ErrResult<E>;

/** A type that represents the result of an asynchronous function that may succeed or fail. */
export type PromiseResult<D, E extends Error = Error> = Promise<Result<D, E>>;

/**
 * Creates an ok result.
 *
 * @param val - the value to wrap in an ok result
 * @returns the ok result
 */
export const ok = <D>(val: D): OkResult<D> => {
  return { ok: true, val, err: undefined };
};

export const err: {
  /**
   * Creates an err result when called with a string.
   *
   * @param message - the error message
   * @returns the err result
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- needed for overload
  <E extends Error, P extends unknown[]>(message: string): ErrResult<E>;
  /**
   * Creates an err result when called with an error.
   *
   * @param error - the error
   * @returns the err result
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- needed for overload
  <E extends Error, P extends unknown[]>(err: E): ErrResult<E>;
  /**
   * Creates an err result when called with an error class.
   *
   * @param errClass - the error class
   * @param args - the arguments to pass to the error class constructor
   * @returns the err result
   */
  <E extends Error, P extends unknown[]>(errClass: new (...args: P) => E, ...args: P): ErrResult<E>;
  // eslint-disable-next-line jsdoc/require-jsdoc -- definitions for polymorphic function are above
} = (
  stringOrErrOrErrClass: string | Error | (new (...args: unknown[]) => Error),
  ...args: unknown[]
) => {
  if (typeof stringOrErrOrErrClass === 'string') {
    return { ok: false, val: undefined, err: new Error(stringOrErrOrErrClass) };
  }
  if (stringOrErrOrErrClass instanceof Error) {
    return { ok: false, val: undefined, err: stringOrErrOrErrClass };
  }
  if (
    typeof stringOrErrOrErrClass === 'function' &&
    stringOrErrOrErrClass.prototype instanceof Error
  ) {
    return { ok: false, val: undefined, err: new stringOrErrOrErrClass(...args) };
  }
  throw new Error('err expects a string, Error, or Error class as an argument');
};

/**
 * Wraps a synchronous or asynchronous computation that may throw an error to return a result object
 *
 * @remarks
 * It is recommended to always define an inline callback function to ensure the this context is
 * correct, thus the callback is not designed to take arguments.
 *
 * @example
 * ```ts
 * const res: Result<Response, NetworkError> = await tryCatch(
 *   () => {
 *     return fetch('https://example.com') // becomes the result
 *   },
 *   (err) => {
 *     if (err.message === 'Network request failed') return new NetworkError('Offline'); // err case
 *     throw err; // rethrow any unexpected errors to not swallow them
 *   });
 * );
 * if(res.val) return await res.val.json();
 * else // handle case that the user is offline
 * ```
 *
 * @param expression - a function that executes code that may throw an error
 * @param errorTransformer - a function that transforms errors that may be thrown by the callback
 * @returns a result object
 */
export const tryCatch = <F extends () => unknown | void, E extends Error = Error>(
  expression: F,
  errorTransformer: (e: Error) => E = (e) => e as E,
): ReturnType<F> extends void
  ? Result<undefined, E>
  : ReturnType<F> extends Promise<void>
  ? PromiseResult<undefined, E>
  : ReturnType<F> extends Promise<unknown>
  ? PromiseResult<Awaited<ReturnType<F>>, E>
  : Result<ReturnType<F>, E> => {
  const makeErrorResult = (e: unknown) => {
    const error =
      e instanceof Error ? e : new Error(`Unexpected throw value '${e}' of type ${typeof e}`);
    return err(errorTransformer(error));
  };
  try {
    const res = expression();
    if (typeof res === 'object' && res !== null && 'then' in res) {
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment -- typescript doesn't understand the ternary return type
      // @ts-ignore
      return Promise.resolve(res)
        .then((val) => ok(val))
        .catch((e) => makeErrorResult(e));
    }
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment -- typescript doesn't understand the ternary return type
    // @ts-ignore
    return ok(res);
    // eslint-disable-next-line no-catch-all/no-catch-all -- this returns all errors as error results
  } catch (e) {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment -- typescript doesn't understand the ternary return type
    // @ts-ignore
    return makeErrorResult(e);
  }
};

export const railway = async <FD, FE extends Error>(
  fn: (
    unwrap: <D, E extends FE>(resultPromise: PromiseResult<D, E> | Result<D, E>) => Promise<D>,
  ) => Promise<FD>,
): PromiseResult<FD, FE> => {
  class ErrorContainer<E> {
    error: E;
    constructor(error: E) {
      this.error = error;
    }
  }

  const unwrap = async <D, E extends FE>(
    resultPromise: PromiseResult<D, E> | Result<D, E>,
  ): Promise<D> => {
    const res = await resultPromise;
    if (!res.ok) throw new ErrorContainer(res.err);
    return res.val;
  };

  try {
    const value = await fn(unwrap);
    return ok(value);
  } catch (e) {
    if (e instanceof ErrorContainer) return err(e.error);
    throw e;
  }
};

// class E1 extends Error {
//   name = 'E1' as const;
// }
// class E2 extends Error {
//   name = 'E2' as const;
// }

// const fna = async (): PromiseResult<number, E1> => ok(1);
// const fnb = async (): PromiseResult<2, E2> => err(E2, 'error');

// (async () => {
//   const out = await railway<number, E1 | E2>(async (unwrap) => {
//     const a = await unwrap(fna());
//     const rb = fnb();
//     const b = await unwrap(rb);
//     return a + b;
//   });
// })();
