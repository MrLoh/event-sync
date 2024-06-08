/**
 * map and transform over the values for all keys of an object
 *
 * @param obj the object to map over
 * @param fn the function to call for each value
 * @returns the object with the mapped values
 */
export const mapObject = <
  O extends { [key: string]: any },
  F extends (value: O[keyof O], key: keyof O) => any,
>(
  obj: O,
  fn: F,
): { [key in keyof O]: ReturnType<F> } => {
  return Object.fromEntries(
    Object.entries(obj).map(([key, value]) => [key, fn(value, key)]),
  ) as any;
};
