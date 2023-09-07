import { mapObject } from './mapObject';

describe('mapObject', () => {
  it('maps over object values', () => {
    // When mapping over the values in an object
    const result = mapObject({ a: 1, b: 2, c: 3 }, (value) => value * 2);
    // Then the values should be transformed correctly
    expect(result).toEqual({ a: 2, b: 4, c: 6 });
  });

  it('can use keys in value mapping function', () => {
    // When mapping over the values in the object and using the keys
    const result = mapObject({ a: 1, b: 2, c: 3 }, (value, key) => `${key}:${value}`);
    // Then the result should be correct
    expect(result).toEqual({ a: 'a:1', b: 'b:2', c: 'c:3' });
  });
});
