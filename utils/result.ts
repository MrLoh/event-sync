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
 * @param val the value to wrap in an ok result
 * @returns the ok result
 */
export const ok = <D>(val: D): OkResult<D> => {
  return { ok: true, val, err: undefined };
};

export const err: {
  /**
   * Creates an err result when called with a string.
   *
   * @param message the error message
   * @returns the err result
   */
  <E extends Error, P extends any[]>(message: string): ErrResult<E>;
  /**
   * Creates an err result when called with an error.
   *
   * @param error the error
   * @returns the err result
   */
  <E extends Error, P extends any[]>(err: E): ErrResult<E>;
  /**
   * Creates an err result when called with an error class.
   *
   * @param errClass the error class
   * @param ...args the arguments to pass to the error class constructor
   * @returns the err result
   */
  <E extends Error, P extends any[]>(errClass: new (...args: P) => E, ...args: P): ErrResult<E>;
} = (stringOrErrOrErrClass: string | Error | (new (...args: any[]) => Error), ...args: any[]) => {
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
 *
 * @param expression a function that executes code that may throw an error
 * @param errorTransformer a function that transforms errors that may be thrown by the callback
 * @returns a result object
 */
export const tryCatch = <F extends () => any | void, E extends Error = Error>(
  expression: F,
  errorTransformer: (err: Error) => E = (err) => err as E
): ReturnType<F> extends void
  ? Result<undefined, E>
  : ReturnType<F> extends Promise<void>
  ? PromiseResult<undefined, E>
  : ReturnType<F> extends Promise<any>
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
      // @ts-ignore typescript doesn't understand the ternary return type
      return Promise.resolve(res)
        .then((val) => ok(val))
        .catch((e) => makeErrorResult(e));
    }
    // @ts-ignore typescript doesn't understand the ternary return type
    return ok(res);
  } catch (e) {
    // @ts-ignore typescript doesn't understand the ternary return type
    return makeErrorResult(e);
  }
};
