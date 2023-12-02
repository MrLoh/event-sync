import { err, ok, tryCatch } from './result';

describe('ok', () => {
  it('creates an ok result', () => {
    // When calling ok with a value
    const res = ok('test');
    // Then the result should be an ok result
    expect(res).toMatchObject({ ok: true, err: undefined });
    // And the result should have the correct value
    expect(res.val).toBe('test');
  });
});

describe('err', () => {
  it('creates an err result when called with an error', () => {
    // When calling err with an error
    const res = err(new Error('test'));
    // Then the result should be an err result
    expect(res).toMatchObject({ ok: false, val: undefined });
    // And the error should be an instance of Error
    expect(res.err).toBeInstanceOf(Error);
    // And the error should have the correct message
    expect(res.err.message).toBe('test');
    // And the error should have a stack trace
    expect(res.err.stack).toBeDefined();
  });

  it('creates an err result when called with an error class', () => {
    // Given a custom error class
    class TestError extends Error {
      name = 'TestError' as const;
      constructor(message: string, public readonly cause: Error) {
        super(message);
      }
    }
    // When calling err with the error class
    const res = err(TestError, 'test', new Error('cause'));
    // Then the result should be an err result
    expect(res).toMatchObject({ ok: false, val: undefined });
    // And the error should be an instance of the error class
    expect(res.err).toBeInstanceOf(TestError);
    // And the error should have the correct name
    expect(res.err.name).toBe('TestError');
    // And the error should have the correct message
    expect(res.err.message).toBe('test');
    // And the error should have the correct cause
    expect(res.err.cause).toBeInstanceOf(Error);
    expect(res.err.cause.message).toBe('cause');
    // And the error should have a stack trace
    expect(res.err.stack).toBeDefined();
  });

  it('creates an err result when called with a string', () => {
    // When calling err with a string
    const res = err('test');
    // Then the result should be an err result
    expect(res).toMatchObject({ ok: false, val: undefined });
    // And the error should be an instance of Error
    expect(res.err).toBeInstanceOf(Error);
    // And the error should have the correct message
    expect(res.err.message).toBe('test');
    // And the error should have a stack trace
    expect(res.err.stack).toBeDefined();
  });

  it('throws an error when called with an invalid argument', () => {
    // When calling err with a random argument
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment -- This is intentional
    // @ts-expect-error
    expect(() => err(1)).toThrow(
      // Then an error should be thrown
      'err expects a string, Error, or Error class as an argument'
    );
    // When calling err with a class that is not an error
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment -- This is intentional
    // @ts-expect-error
    expect(() => err(class Test {})).toThrow(
      // Then an error should be thrown
      'err expects a string, Error, or Error class as an argument'
    );
  });
});

describe('tryCatch', () => {
  it('returns an ok result for synchronous function', () => {
    // When calling the function with a synchronous function
    const res = tryCatch(() => 'test');
    // Then the result should be an ok result
    expect(res).toMatchObject({ ok: true, err: undefined });
    // And the result should have the correct value
    expect(res.val).toBe('test');
  });

  it('returns an ok result for asynchronous function', async () => {
    // When calling the function with an asynchronous function
    const res = await tryCatch(async () => Promise.resolve('test'));
    // Then the result should be an ok result
    expect(res).toMatchObject({ ok: true, err: undefined });
    // And the result should have the correct value
    expect(res.val).toBe('test');
  });

  it('returns an err result for synchronous function that throws', () => {
    // When calling the function with a synchronous function that throws
    const res = tryCatch(() => {
      throw new Error('test');
    });
    // Then the result should be an err result
    expect(res).toMatchObject({ ok: false, val: undefined });
    // And the result should have the correct error
    expect(res.err).toBeInstanceOf(Error);
    expect((res.err as Error).message).toBe('test');
  });

  it('returns an err result for asynchronous function that rejects', async () => {
    // When calling the function with an asynchronous function that rejects
    const res = await tryCatch(async () => Promise.reject(new Error('test')));
    // Then the result should be an err result
    expect(res).toMatchObject({ ok: false, val: undefined });
    // And the result should have the correct error
    expect(res.err).toBeInstanceOf(Error);
    expect((res.err as Error).message).toBe('test');
  });

  it('returns an err result if function throws a non-error', async () => {
    // When calling the function with a function that throws a non-error
    const res = await tryCatch(async () => Promise.reject('test'));
    // Then the result should be an err result
    expect(res).toMatchObject({ ok: false, val: undefined });
    // And the result should have the correct error
    expect(res.err).toBeInstanceOf(Error);
    expect((res.err as Error).message).toBe("Unexpected throw value 'test' of type string");
  });

  it('can take a custom error transformer', async () => {
    // Given a custom error class
    class AnticipatedError extends Error {
      name = 'AnticipatedError' as const;
    }
    // And an error transformer that rethrows all but some specific errors
    const errorTransformer = (e: Error) => {
      if (e.message === 'expected error') return new AnticipatedError();
      throw e;
    };
    // When calling the function with a function that throws an anticipated error
    const res = await tryCatch(() => Promise.reject(new Error('expected error')), errorTransformer);
    // Then the result should be an err result
    expect(res).toMatchObject({ ok: false, val: undefined });
    // And the result should have the correct error
    expect(res.err).toBeInstanceOf(AnticipatedError);
    expect((res.err as AnticipatedError).name).toBe('AnticipatedError');
    // When calling the function with a function that throws an unexpected error
    await expect(
      () => tryCatch(() => Promise.reject(new Error('unexpected error')), errorTransformer)
      // Then an error should be thrown
    ).rejects.toThrow('unexpected error');
  });
});
