export const tryCatch = async <T>(
  fn: () => T
): Promise<{ res: undefined; err: Error } | { res: Awaited<T>; err: undefined }> => {
  try {
    const res = await fn();
    return { res, err: undefined };
  } catch (err: any) {
    if (!(err instanceof Error)) err = new Error(`Unexpected throw value: ${err}`);
    return { res: undefined, err };
  }
};
